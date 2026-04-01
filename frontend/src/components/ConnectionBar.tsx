import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

interface Props {
  onAiClick: () => void;
}

export function ConnectionBar({ onAiClick }: Props) {
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [port, setPort] = useState("21");
  const [protocol, setProtocol] = useState("ftp");
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    if (!host || !username) return;
    setConnecting(true);
    try {
      await invoke("connect", {
        args: { host, port: parseInt(port), username, password, protocol },
      });
    } catch (err) {
      console.error("Connection failed:", err);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card">
      <select
        value={protocol}
        onChange={(e) => setProtocol(e.target.value)}
        className="text-sm bg-input border border-border rounded px-2 py-1"
      >
        <option value="ftp">FTP</option>
        <option value="ftps">FTPS</option>
        <option value="ftps_implicit">FTPS (Implicit)</option>
        <option value="sftp">SFTP</option>
        <option value="webdav">WebDAV</option>
        <option value="s3">S3</option>
      </select>

      <input
        type="text"
        placeholder="Host"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        className="flex-1 text-sm bg-input border border-border rounded px-2 py-1"
      />
      <input
        type="text"
        placeholder="Port"
        value={port}
        onChange={(e) => setPort(e.target.value)}
        className="w-16 text-sm bg-input border border-border rounded px-2 py-1"
      />
      <input
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        className="w-28 text-sm bg-input border border-border rounded px-2 py-1"
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-28 text-sm bg-input border border-border rounded px-2 py-1"
      />

      <button
        onClick={handleConnect}
        disabled={connecting}
        className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
      >
        {connecting ? "Connecting..." : "Connect"}
      </button>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onAiClick}
          className="px-3 py-1 text-sm bg-violet-600 text-white rounded hover:bg-violet-500"
          title="AI Assistant"
        >
          ✨ AI
        </button>
        <button
          className="px-2 py-1 text-sm border border-border rounded hover:bg-accent"
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}
