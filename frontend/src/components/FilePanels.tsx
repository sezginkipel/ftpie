import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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

// Sürükle-bırak için taşınan dosya bilgisi
interface DragPayload {
  file: FileEntry;
  isRemote: boolean;
}

const DRAG_KEY = "ftpie/drag";

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
  drives,
  onDrop,
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
  drives?: string[];
  onDrop: (payload: DragPayload) => void;
}) {
  const [pathInput, setPathInput] = useState(currentPath);
  const [dragOver, setDragOver] = useState(false);
  const dragRef = useRef<DragPayload | null>(null);

  // Path input, dışarıdan değişirse güncelle
  useEffect(() => { setPathInput(currentPath); }, [currentPath]);

  return (
    <div
      className={`flex-1 flex flex-col border-r border-border last:border-r-0 overflow-hidden ${dragOver ? "ring-2 ring-inset ring-primary/60" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const raw = e.dataTransfer.getData(DRAG_KEY);
        if (!raw) return;
        const payload: DragPayload = JSON.parse(raw);
        // Aynı panel içine bırakma → geçersiz
        if (payload.isRemote === isRemote) return;
        onDrop(payload);
      }}
    >
      {/* Path bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card">
        <span className="text-xs font-medium text-muted-foreground shrink-0">{title}</span>

        {/* Windows disk seçici (sadece yerel panel) */}
        {!isRemote && drives && drives.length > 0 && (
          <select
            value={currentPath.slice(0, 3)}
            onChange={(e) => { onNavigate(e.target.value); }}
            className="text-xs bg-input border border-border rounded px-1 py-0.5 shrink-0 w-16"
            title="Disk seç"
          >
            {drives.map((d) => (
              <option key={d} value={d}>{d.replace(":/", ":")}</option>
            ))}
          </select>
        )}

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
        {/* Üst dizin (..) */}
        {currentPath !== "/" && currentPath.length > 3 && (
          <div
            className="flex items-center gap-2 px-3 py-0.5 cursor-pointer hover:bg-accent/50 text-muted-foreground"
            onDoubleClick={() => {
              const parent = currentPath.replace(/[/\\][^/\\]+[/\\]?$/, "") || currentPath.slice(0, 3);
              onNavigate(parent.endsWith("/") ? parent : parent + "/");
            }}
          >
            <span>📁</span>
            <span className="text-xs">..</span>
          </div>
        )}
        {files.map((file) => (
          <div
            key={file.path}
            draggable={!file.is_dir}
            onDragStart={(e) => {
              const payload: DragPayload = { file, isRemote };
              e.dataTransfer.setData(DRAG_KEY, JSON.stringify(payload));
              e.dataTransfer.effectAllowed = "copy";
              dragRef.current = payload;
            }}
            className={`flex items-center gap-2 px-3 py-0.5 cursor-pointer select-none ${
              selected === file.path
                ? "bg-primary/20 text-foreground"
                : "hover:bg-accent/50 text-foreground"
            } ${!file.is_dir ? "draggable" : ""}`}
            onClick={() => onSelect(file)}
            onDoubleClick={() => {
              if (file.is_dir) {
                const next = file.path.endsWith("/") ? file.path : file.path + "/";
                onNavigate(next);
              } else if (isRemote && onOpen) {
                onOpen(file);
              }
            }}
            title={!file.is_dir ? "Sürükleyerek transfer et" : undefined}
          >
            <span className="text-sm shrink-0">
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

        {/* Drop hedefi göstergesi */}
        {dragOver && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-primary/10 border-2 border-dashed border-primary rounded-lg px-6 py-4 text-sm text-primary font-medium">
              {isRemote ? "Buraya bırak → Yükle" : "Buraya bırak → İndir"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function FilePanels() {
  const { activeSessionId } = useSessionStore();
  const { openTab } = useEditorStore();
  const queryClient = useQueryClient();

  const [localPath, setLocalPath] = useState("C:/");
  const [remotePath, setRemotePath] = useState("/");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [remoteSelected, setRemoteSelected] = useState<string | null>(null);
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [drives, setDrives] = useState<string[]>([]);
  const [transferMsg, setTransferMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    invoke<string[]>("list_drives").then(setDrives).catch(() => {});
  }, []);

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

  const showMsg = (text: string, ok: boolean) => {
    setTransferMsg({ text, ok });
    setTimeout(() => setTransferMsg(null), 4000);
  };

  // Sürükle-bırak transfer
  const handleDrop = async (payload: DragPayload) => {
    if (!activeSessionId) { showMsg("Önce bir sunucuya bağlan", false); return; }
    const { file, isRemote: fromRemote } = payload;
    try {
      if (fromRemote) {
        // Uzak → yerel (indirme)
        const dest = (localPath.replace(/[/\\]$/, "") + "/" + file.name).replace(/\\/g, "/");
        showMsg(`↓ İndiriliyor: ${file.name}…`, true);
        await invoke("download", { sessionId: activeSessionId, remotePath: file.path, localPath: dest });
        queryClient.invalidateQueries({ queryKey: ["local", localPath] });
        showMsg(`✓ İndirildi: ${file.name}`, true);
      } else {
        // Yerel → uzak (yükleme)
        const dest = (remotePath.replace(/\/$/, "") + "/" + file.name);
        showMsg(`↑ Yükleniyor: ${file.name}…`, true);
        await invoke("upload", { sessionId: activeSessionId, localPath: file.path, remotePath: dest });
        queryClient.invalidateQueries({ queryKey: ["remote", remotePath, activeSessionId] });
        showMsg(`✓ Yüklendi: ${file.name}`, true);
      }
    } catch (err) {
      showMsg(`Hata: ${err}`, false);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Transfer mesajı */}
      {transferMsg && (
        <div className={`px-4 py-1 text-xs border-b ${transferMsg.ok ? "bg-green-950/30 text-green-300 border-green-900/40" : "bg-red-950/30 text-red-400 border-red-900/40"}`}>
          {transferMsg.text}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden relative">
        <FilePanel
          title="Yerel"
          files={localFiles}
          currentPath={localPath}
          onNavigate={setLocalPath}
          onSelect={(f) => setLocalSelected(f.path)}
          selected={localSelected}
          isRemote={false}
          loading={localLoading}
          drives={drives}
          onDrop={handleDrop}
        />
        <FilePanel
          title={activeSessionId ? "Uzak" : "Uzak (bağlı değil)"}
          files={remoteFiles}
          currentPath={remotePath}
          onNavigate={setRemotePath}
          onSelect={(f) => setRemoteSelected(f.path)}
          onOpen={openInEditor}
          selected={remoteSelected}
          isRemote={true}
          loading={remoteLoading || !!openingFile}
          onDrop={handleDrop}
        />
      </div>
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
