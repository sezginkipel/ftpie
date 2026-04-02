import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../store/sessionStore";

interface Participant {
  id: string;
  name: string;
  color: string;
  current_path: string | null;
}

interface CollabSession {
  code: string;
  owner_id: string;
  participants: Participant[];
  ftp_session_id: string;
}

interface ChatMessage {
  participantId: string;
  participantName: string;
  color: string;
  message: string;
  timestamp: string;
}

interface CollabEvent {
  code: string;
  event: {
    kind: string;
    participant?: Participant;
    participant_id?: string;
    message?: string;
    path?: string;
    action?: string;
  };
}

interface Props {
  onClose: () => void;
}

export function CollaborationPanel({ onClose }: Props) {
  const { activeSessionId } = useSessionStore();
  const [mode, setMode] = useState<"idle" | "host" | "join">("idle");
  const [session, setSession] = useState<CollabSession | null>(null);
  const [myId, setMyId] = useState<string>("");
  const [myName, setMyName] = useState("Me");
  const [joinCode, setJoinCode] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Listen to collab events from Tauri
  useEffect(() => {
    if (!session) return;

    const unlisten = listen<CollabEvent>("collab://event", (e) => {
      const ev = e.payload.event;
      if (e.payload.code !== session.code) return;

      if (ev.kind === "participant_joined" && ev.participant) {
        setSession((prev) =>
          prev
            ? { ...prev, participants: [...prev.participants, ev.participant!] }
            : prev
        );
        setActivityLog((prev) => [
          ...prev,
          `${ev.participant!.name} joined the session`,
        ]);
      } else if (ev.kind === "participant_left" && ev.participant_id) {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                participants: prev.participants.filter(
                  (p) => p.id !== ev.participant_id
                ),
              }
            : prev
        );
        setActivityLog((prev) => [
          ...prev,
          `A participant left the session`,
        ]);
      } else if (ev.kind === "chat" && ev.message) {
        const sender = session.participants.find(
          (p) => p.id === ev.participant_id
        );
        if (sender) {
          setChatMessages((prev) => [
            ...prev,
            {
              participantId: sender.id,
              participantName: sender.name,
              color: sender.color,
              message: ev.message!,
              timestamp: new Date().toLocaleTimeString(),
            },
          ]);
        }
      } else if (ev.kind === "navigate" && ev.path) {
        const actor = session.participants.find(
          (p) => p.id === ev.participant_id
        );
        setActivityLog((prev) => [
          ...prev,
          `${actor?.name ?? "?"} navigated to ${ev.path}`,
        ]);
        setSession((prev) =>
          prev
            ? {
                ...prev,
                participants: prev.participants.map((p) =>
                  p.id === ev.participant_id
                    ? { ...p, current_path: ev.path! }
                    : p
                ),
              }
            : prev
        );
      } else if (ev.kind === "file_action") {
        const actor = session.participants.find(
          (p) => p.id === ev.participant_id
        );
        setActivityLog((prev) => [
          ...prev,
          `${actor?.name ?? "?"} performed ${ev.action} on ${ev.path}`,
        ]);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [session]);

  const createSession = async () => {
    if (!activeSessionId) {
      alert("No active FTP session");
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<{ code: string; session: CollabSession }>(
        "create_collab_session",
        { ftpSessionId: activeSessionId, ownerName: myName }
      );
      setSession(result.session);
      setMyId(result.session.owner_id);
      setMode("host");
      setActivityLog([`Session created with code ${result.code}`]);
    } catch (err) {
      alert(`Failed to create session: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const joinSession = async () => {
    if (!joinCode.trim()) return;
    setLoading(true);
    try {
      const result = await invoke<CollabSession>("join_collab_session", {
        args: { code: joinCode.toUpperCase(), participant_name: myName },
      });
      const me = result.participants[result.participants.length - 1];
      setSession(result);
      setMyId(me.id);
      setMode("join");
      setActivityLog([`Joined session ${result.code}`]);
    } catch (err) {
      alert(`Failed to join session: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const leaveSession = async () => {
    if (!session || !myId) return;
    try {
      await invoke("leave_collab_session", {
        code: session.code,
        participantId: myId,
      });
    } catch (_) {}
    setSession(null);
    setMyId("");
    setMode("idle");
    setChatMessages([]);
    setActivityLog([]);
  };

  const sendChat = async () => {
    const msg = chatInput.trim();
    if (!msg || !session || !myId) return;
    setChatInput("");
    // Optimistic local add
    const me = session.participants.find((p) => p.id === myId);
    setChatMessages((prev) => [
      ...prev,
      {
        participantId: myId,
        participantName: me?.name ?? myName,
        color: me?.color ?? "#6366f1",
        message: msg,
        timestamp: new Date().toLocaleTimeString(),
      },
    ]);
    try {
      await invoke("broadcast_collab_event", {
        code: session.code,
        event: { kind: "chat", participant_id: myId, message: msg },
      });
    } catch (_) {}
  };

  const copyCode = () => {
    if (session) navigator.clipboard.writeText(session.code);
  };

  return (
    <div className="w-72 border-l border-border bg-card flex flex-col text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-medium">👥 Collaboration</span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none"
        >
          ×
        </button>
      </div>

      {!session ? (
        /* Setup screen */
        <div className="flex-1 p-3 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground">Your name</label>
            <input
              type="text"
              value={myName}
              onChange={(e) => setMyName(e.target.value)}
              className="w-full mt-0.5 bg-input border border-border rounded px-2 py-1 text-xs"
              placeholder="Display name"
            />
          </div>

          {/* Create */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Host a Session
            </p>
            <button
              onClick={createSession}
              disabled={loading || !activeSessionId}
              className="w-full text-xs px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? "Creating…" : "Create Session"}
            </button>
            {!activeSessionId && (
              <p className="text-xs text-red-400">Connect to FTP first</p>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Join */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Join a Session
            </p>
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="XXXXXX"
              className="w-full bg-input border border-border rounded px-2 py-1 text-xs font-mono tracking-widest"
            />
            <button
              onClick={joinSession}
              disabled={loading || joinCode.length < 6}
              className="w-full text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Joining…" : "Join Session"}
            </button>
          </div>
        </div>
      ) : (
        /* Active session */
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Session code */}
          <div className="px-3 py-2 border-b border-border bg-indigo-950/30">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Session Code
                </p>
                <p className="font-mono text-lg font-bold tracking-widest text-indigo-400">
                  {session.code}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <button
                  onClick={copyCode}
                  className="text-xs px-2 py-0.5 border border-border rounded hover:bg-accent"
                >
                  Copy
                </button>
                <button
                  onClick={leaveSession}
                  className="text-xs px-2 py-0.5 border border-red-800 text-red-400 rounded hover:bg-red-950/30"
                >
                  Leave
                </button>
              </div>
            </div>
          </div>

          {/* Participants */}
          <div className="border-b border-border">
            <p className="px-3 pt-2 pb-1 text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
              Participants ({session.participants.length})
            </p>
            <div className="pb-2 space-y-0.5">
              {session.participants.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 px-3 py-0.5"
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: p.color }}
                  />
                  <span className="text-xs truncate">
                    {p.name}
                    {p.id === myId && (
                      <span className="text-muted-foreground"> (you)</span>
                    )}
                  </span>
                  {p.current_path && (
                    <span className="text-[10px] text-muted-foreground truncate ml-auto font-mono">
                      {p.current_path.split("/").pop()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Activity log */}
          {activityLog.length > 0 && (
            <div className="border-b border-border max-h-20 overflow-y-auto">
              <p className="px-3 pt-1.5 pb-1 text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                Activity
              </p>
              {activityLog.slice(-5).map((entry, i) => (
                <p key={i} className="px-3 text-[11px] text-muted-foreground pb-0.5">
                  {entry}
                </p>
              ))}
            </div>
          )}

          {/* Chat */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {chatMessages.length === 0 && (
              <p className="text-xs text-muted-foreground text-center mt-4">
                No messages yet
              </p>
            )}
            {chatMessages.map((msg, i) => {
              const isMe = msg.participantId === myId;
              return (
                <div key={i} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                  <div className="flex items-center gap-1 mb-0.5">
                    <span
                      className="text-[10px] font-medium"
                      style={{ color: msg.color }}
                    >
                      {isMe ? "You" : msg.participantName}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {msg.timestamp}
                    </span>
                  </div>
                  <div
                    className={`rounded-lg px-3 py-1.5 text-xs max-w-[90%] ${
                      isMe
                        ? "bg-indigo-600 text-white"
                        : "bg-muted text-foreground"
                    }`}
                  >
                    {msg.message}
                  </div>
                </div>
              );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div className="p-3 border-t border-border flex gap-2">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()}
              placeholder="Message…"
              className="flex-1 text-xs bg-input border border-border rounded px-2 py-1.5"
            />
            <button
              onClick={sendChat}
              disabled={!chatInput.trim()}
              className="px-2 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-500 disabled:opacity-50 shrink-0"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
