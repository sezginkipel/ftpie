import { useState } from "react";
import { useSessionStore } from "../store/sessionStore";

interface Props {
  onAiClick: () => void;
  onScriptClick: () => void;
  onGitClick: () => void;
  onCollabClick: () => void;
}

export function ConnectionBar({ onAiClick, onScriptClick, onGitClick, onCollabClick }: Props) {
  const { sessions, activeSessionId, connect, disconnect, setActive } = useSessionStore();
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [port, setPort] = useState("21");
  const [protocol, setProtocol] = useState("ftp");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!host || !username) return;
    setConnecting(true);
    setError(null);
    try {
      await connect({
        host,
        port: parseInt(port),
        username,
        password: password || undefined,
        protocol,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setConnecting(false);
    }
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div className="flex flex-col border-b border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-2">
        <select
          value={protocol}
          onChange={(e) => setProtocol(e.target.value)}
          className="text-sm bg-input border border-border rounded px-2 py-1 shrink-0"
        >
          <option value="ftp">FTP</option>
          <option value="ftps">FTPS</option>
          <option value="ftps_implicit">FTPS (Implicit)</option>
          <option value="sftp">SFTP</option>
        </select>

        <input
          type="text"
          placeholder="Host"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleConnect()}
          className="flex-1 min-w-0 text-sm bg-input border border-border rounded px-2 py-1"
        />
        <input
          type="text"
          placeholder="Port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="w-14 text-sm bg-input border border-border rounded px-2 py-1 shrink-0"
        />
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-28 text-sm bg-input border border-border rounded px-2 py-1 shrink-0"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleConnect()}
          className="w-28 text-sm bg-input border border-border rounded px-2 py-1 shrink-0"
        />

        <button
          onClick={handleConnect}
          disabled={connecting || !host || !username}
          className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 shrink-0"
        >
          {connecting ? "Connecting…" : "Connect"}
        </button>

        {/* Active session indicator + disconnect */}
        {activeSession && (
          <div className="flex items-center gap-1.5 text-xs bg-green-950/40 border border-green-800/50 rounded px-2 py-1 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span className="text-green-300 truncate max-w-[100px]">
              {activeSession.username}@{activeSession.host}
            </span>
            <button
              onClick={() => disconnect(activeSession.id)}
              className="text-red-400 hover:text-red-300 ml-0.5"
              title="Disconnect"
            >
              ×
            </button>
          </div>
        )}

        {/* Multiple sessions switcher */}
        {sessions.length > 1 && (
          <select
            value={activeSessionId ?? ""}
            onChange={(e) => setActive(e.target.value)}
            className="text-xs bg-input border border-border rounded px-1.5 py-1 shrink-0"
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.host}
              </option>
            ))}
          </select>
        )}

        {/* Feature buttons */}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button
            onClick={onGitClick}
            className="px-2 py-1 text-xs border border-border rounded hover:bg-accent"
            title="Git Deploy"
          >
            🌿 Git
          </button>
          <button
            onClick={onScriptClick}
            className="px-2 py-1 text-xs border border-border rounded hover:bg-accent"
            title="Script Manager"
          >
            ⚙ Scripts
          </button>
          <button
            onClick={onCollabClick}
            className="px-2 py-1 text-xs border border-border rounded hover:bg-accent"
            title="Collaboration"
          >
            👥 Collab
          </button>
          <button
            onClick={onAiClick}
            className="px-2.5 py-1 text-xs bg-violet-600 text-white rounded hover:bg-violet-500"
            title="AI Assistant"
          >
            ✨ AI
          </button>
        </div>
      </div>

      {/* Error bar */}
      {error && (
        <div className="px-4 py-1 text-xs text-red-400 bg-red-950/30 border-t border-red-900/50">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-500 hover:text-red-300">✕</button>
        </div>
      )}
    </div>
  );
}
