import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { useSessionStore } from "../store/sessionStore";

interface FileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
  is_symlink?: boolean;
}

interface EditorFile {
  path: string;
  content: string;
  language: string;
  original_hash: string;
  size: number;
  is_binary: boolean;
}

function FilePanel({
  title,
  files,
  currentPath,
  onNavigate,
  onSelect,
  onOpen,
  selected,
  isRemote,
  loading,
}: {
  title: string;
  files: FileEntry[];
  currentPath: string;
  onNavigate: (path: string) => void;
  onSelect: (file: FileEntry) => void;
  onOpen?: (file: FileEntry) => void;
  selected: string | null;
  isRemote: boolean;
  loading: boolean;
}) {
  const [pathInput, setPathInput] = useState(currentPath);

  return (
    <div className="flex-1 flex flex-col border-r border-border last:border-r-0 overflow-hidden">
      {/* Path bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card">
        <span className="text-xs font-medium text-muted-foreground shrink-0">{title}</span>
        <input
          type="text"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onNavigate(pathInput)}
          className="flex-1 bg-input border border-border rounded px-2 py-0.5 text-xs font-mono"
        />
        <button
          onClick={() => onNavigate(pathInput)}
          className="text-xs px-2 py-0.5 border border-border rounded hover:bg-accent shrink-0"
        >
          Go
        </button>
      </div>

      {/* Column headers */}
      <div className="flex items-center px-3 py-0.5 border-b border-border bg-card/50">
        <span className="flex-1 text-xs font-medium text-muted-foreground">Name</span>
        <span className="w-20 text-right text-xs font-medium text-muted-foreground">Size</span>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="px-3 py-2 text-xs text-muted-foreground animate-pulse">Loading…</div>
        )}
        {/* Parent directory */}
        {currentPath !== "/" && (
          <div
            className="flex items-center gap-2 px-3 py-0.5 cursor-pointer hover:bg-accent/50 text-muted-foreground"
            onDoubleClick={() => {
              const parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
              onNavigate(parent);
              setPathInput(parent);
            }}
          >
            <span>📁</span>
            <span className="text-xs">..</span>
          </div>
        )}
        {files.map((file) => (
          <div
            key={file.path}
            className={`flex items-center gap-2 px-3 py-0.5 cursor-pointer ${
              selected === file.path
                ? "bg-primary/20 text-foreground"
                : "hover:bg-accent/50 text-foreground"
            }`}
            onClick={() => onSelect(file)}
            onDoubleClick={() => {
              if (file.is_dir) {
                onNavigate(file.path);
                setPathInput(file.path);
              } else if (isRemote && onOpen) {
                onOpen(file);
              }
            }}
          >
            <span className="text-sm">
              {file.is_dir ? "📁" : getFileIcon(file.name)}
            </span>
            <span className="flex-1 text-xs truncate">{file.name}</span>
            <span className="w-20 text-right text-xs text-muted-foreground shrink-0">
              {file.is_dir ? "" : formatSize(file.size)}
            </span>
          </div>
        ))}
        {!loading && files.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Empty directory</div>
        )}
      </div>
    </div>
  );
}

export function FilePanels() {
  const { activeSessionId } = useSessionStore();
  const { openTab } = useEditorStore();
  const [localPath, setLocalPath] = useState("/");
  const [remotePath, setRemotePath] = useState("/");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [remoteSelected, setRemoteSelected] = useState<string | null>(null);
  const [openingFile, setOpeningFile] = useState<string | null>(null);

  const { data: localFiles = [], isFetching: localLoading } = useQuery({
    queryKey: ["local", localPath],
    queryFn: () => invoke<FileEntry[]>("list_local", { path: localPath }),
    enabled: true,
  });

  const { data: remoteFiles = [], isFetching: remoteLoading } = useQuery({
    queryKey: ["remote", remotePath, activeSessionId],
    queryFn: () =>
      invoke<FileEntry[]>("list_remote", {
        sessionId: activeSessionId ?? "",
        path: remotePath,
      }),
    enabled: !!activeSessionId,
  });

  const openInEditor = async (file: FileEntry) => {
    if (!activeSessionId) return;
    setOpeningFile(file.name);
    try {
      const result = await invoke<EditorFile>("editor_open_file", {
        sessionId: activeSessionId,
        remotePath: file.path,
      });
      openTab({
        id: crypto.randomUUID(),
        sessionId: activeSessionId,
        remotePath: file.path,
        name: file.name,
        content: result.content,
        originalContent: result.content,
        originalHash: result.original_hash,
        language: result.language,
        isBinary: result.is_binary,
      });
    } catch (err) {
      console.error("Failed to open file:", err);
    } finally {
      setOpeningFile(null);
    }
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      <FilePanel
        title="Local"
        files={localFiles}
        currentPath={localPath}
        onNavigate={setLocalPath}
        onSelect={(f) => setLocalSelected(f.path)}
        selected={localSelected}
        isRemote={false}
        loading={localLoading}
      />
      <FilePanel
        title={activeSessionId ? "Remote" : "Remote (not connected)"}
        files={remoteFiles}
        currentPath={remotePath}
        onNavigate={setRemotePath}
        onSelect={(f) => setRemoteSelected(f.path)}
        onOpen={openInEditor}
        selected={remoteSelected}
        isRemote={true}
        loading={remoteLoading || !!openingFile}
      />
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const icons: Record<string, string> = {
    php: "🐘", js: "📜", ts: "📜", tsx: "⚛️", jsx: "⚛️",
    html: "🌐", css: "🎨", scss: "🎨", json: "📋",
    md: "📝", sql: "🗄️", sh: "⚙️", py: "🐍",
    rs: "🦀", go: "🐹", rb: "💎", java: "☕",
    png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️",
    zip: "📦", tar: "📦", gz: "📦", rar: "📦",
    pdf: "📕", txt: "📄", log: "📃",
  };
  return icons[ext] ?? "📄";
}
