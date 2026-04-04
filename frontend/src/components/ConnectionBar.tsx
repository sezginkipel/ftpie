import { useState } from "react";
import { useSessionStore } from "../store/sessionStore";
import { useSettingsStore } from "../store/settingsStore";
import { SessionTabBar } from "./SessionTabBar";
import { SettingsModal } from "./SettingsModal";

interface Props {
  onAiClick: () => void;
  onScriptClick: () => void;
  onGitClick: () => void;
  onCollabClick: () => void;
}

export function ConnectionBar({ onAiClick, onScriptClick, onGitClick, onCollabClick }: Props) {
  const { connect } = useSessionStore();
  const { settings } = useSettingsStore();
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(String(settings.defaultPort));
  const [protocol, setProtocol] = useState(settings.defaultProtocol);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

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

  return (
    <div className="flex flex-col border-b border-border bg-card shrink-0">
      {/* Input row */}
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
          <button
            onClick={() => setShowSettings(true)}
            className="px-2 py-1 text-xs border border-border rounded hover:bg-accent"
            title="Settings"
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* Session tab bar */}
      <SessionTabBar />

      {/* Error bar */}
      {error && (
        <div className="px-4 py-1 text-xs text-red-400 bg-red-950/30 border-t border-red-900/50">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-500 hover:text-red-300">✕</button>
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}
