import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useBookmarkStore } from "../store/bookmarkStore";
import { useSessionStore } from "../store/sessionStore";

interface AddBookmarkForm {
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  protocol: string;
}

export function Sidebar() {
  const { bookmarks, load, create, delete: deleteBookmark, connectBookmark } = useBookmarkStore();
  const { activeSessionId } = useSessionStore();
  const [gitBranch, setGitBranch] = useState<string>("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<AddBookmarkForm>({
    name: "",
    host: "",
    port: "21",
    username: "",
    password: "",
    protocol: "ftp",
  });
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [masterPassword, setMasterPassword] = useState("");
  const [showMasterPwd, setShowMasterPwd] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  const handleAdd = async () => {
    if (!form.name || !form.host) return;
    await create({
      name: form.name,
      host: form.host,
      port: parseInt(form.port),
      username: form.username,
      password: form.password || undefined,
      protocol: form.protocol,
    });
    setForm({ name: "", host: "", port: "21", username: "", password: "", protocol: "ftp" });
    setShowAdd(false);
  };

  const handleConnect = async (id: string) => {
    setShowMasterPwd(id);
  };

  const confirmConnect = async () => {
    if (!showMasterPwd) return;
    setConnectingId(showMasterPwd);
    try {
      await connectBookmark(showMasterPwd, masterPassword);
    } catch (err) {
      alert(`Connection failed: ${err}`);
    } finally {
      setConnectingId(null);
      setShowMasterPwd(null);
      setMasterPassword("");
    }
  };

  return (
    <div className="w-52 border-r border-border bg-card flex flex-col overflow-hidden text-sm">
      {/* Bookmarks header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Bookmarks
        </span>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-xs text-muted-foreground hover:text-foreground"
          title="Add bookmark"
        >
          +
        </button>
      </div>

      {/* Add bookmark form */}
      {showAdd && (
        <div className="border-b border-border p-2 space-y-1 bg-background/50">
          <select
            value={form.protocol}
            onChange={(e) => setForm({ ...form, protocol: e.target.value })}
            className="w-full text-xs bg-input border border-border rounded px-1.5 py-0.5"
          >
            <option value="ftp">FTP</option>
            <option value="ftps">FTPS</option>
            <option value="sftp">SFTP</option>
          </select>
          <input
            type="text"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full text-xs bg-input border border-border rounded px-1.5 py-0.5"
          />
          <input
            type="text"
            placeholder="Host"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            className="w-full text-xs bg-input border border-border rounded px-1.5 py-0.5"
          />
          <div className="flex gap-1">
            <input
              type="text"
              placeholder="User"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="flex-1 text-xs bg-input border border-border rounded px-1.5 py-0.5"
            />
            <input
              type="text"
              placeholder="Port"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: e.target.value })}
              className="w-12 text-xs bg-input border border-border rounded px-1.5 py-0.5"
            />
          </div>
          <input
            type="password"
            placeholder="Password (optional)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full text-xs bg-input border border-border rounded px-1.5 py-0.5"
          />
          <div className="flex gap-1">
            <button
              onClick={handleAdd}
              className="flex-1 text-xs py-0.5 bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              Save
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="flex-1 text-xs py-0.5 border border-border rounded hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Bookmark list */}
      <div className="flex-1 overflow-y-auto py-1">
        {bookmarks.length === 0 && (
          <p className="px-3 py-1 text-xs text-muted-foreground">No bookmarks yet.</p>
        )}
        {bookmarks.map((bm) => (
          <div
            key={bm.id}
            className="group px-3 py-1.5 hover:bg-accent/50 cursor-pointer"
            onDoubleClick={() => handleConnect(bm.id)}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium truncate text-xs">{bm.name}</span>
              <button
                className="hidden group-hover:block text-muted-foreground hover:text-red-400 text-xs ml-1"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete bookmark "${bm.name}"?`)) deleteBookmark(bm.id);
                }}
              >
                ✕
              </button>
            </div>
            <div className="text-[11px] text-muted-foreground truncate">
              {bm.protocol}://{bm.host}
            </div>
            {connectingId === bm.id && (
              <div className="text-[11px] text-indigo-400 animate-pulse">Connecting…</div>
            )}
          </div>
        ))}
      </div>

      {/* Master password dialog */}
      {showMasterPwd && (
        <div className="border-t border-border p-2 bg-background/80 space-y-1">
          <p className="text-[11px] text-muted-foreground">Master password to decrypt:</p>
          <input
            type="password"
            value={masterPassword}
            onChange={(e) => setMasterPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmConnect()}
            placeholder="Master password"
            className="w-full text-xs bg-input border border-border rounded px-1.5 py-0.5"
            autoFocus
          />
          <div className="flex gap-1">
            <button
              onClick={confirmConnect}
              className="flex-1 text-xs py-0.5 bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              Connect
            </button>
            <button
              onClick={() => { setShowMasterPwd(null); setMasterPassword(""); }}
              className="flex-1 text-xs py-0.5 border border-border rounded hover:bg-accent"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Git section */}
      <div className="border-t border-border">
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Git
        </div>
        <div className="pb-2">
          {gitBranch ? (
            <div className="px-3 py-0.5 flex items-center gap-2">
              <span className="text-green-400 text-xs">●</span>
              <span className="font-mono text-xs truncate">{gitBranch}</span>
            </div>
          ) : (
            <p className="px-3 text-xs text-muted-foreground">No repository.</p>
          )}
        </div>
      </div>
    </div>
  );
}
