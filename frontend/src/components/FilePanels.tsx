import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorStore } from "../store/editorStore";
import { useSessionStore } from "../store/sessionStore";
import { useSettingsStore } from "../store/settingsStore";
import { ContextMenu, ContextMenuItem } from "./ContextMenu";

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

interface DragPayload {
  files: FileEntry[];
  isRemote: boolean;
}

// dataTransfer type keys
const DT_LOCAL = "ftpie/local";
const DT_REMOTE = "ftpie/remote";

// ── FilePanel ────────────────────────────────────────────────────────────────

function FilePanel({
  title,
  files,
  currentPath,
  onNavigate,
  selected,
  onSelect,
  onOpen,
  isRemote,
  loading,
  drives,
  onDrop,
  onContextMenu,
}: {
  title: string;
  files: FileEntry[];
  currentPath: string;
  onNavigate: (path: string) => void;
  selected: Set<string>;
  onSelect: (file: FileEntry, ctrl: boolean, shift: boolean) => void;
  onOpen?: (file: FileEntry) => void;
  isRemote: boolean;
  loading: boolean;
  drives?: string[];
  onDrop: (payload: DragPayload) => void;
  onContextMenu: (e: React.MouseEvent, file: FileEntry | null) => void;
}) {
  const [pathInput, setPathInput] = useState(currentPath);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

  useEffect(() => { setPathInput(currentPath); }, [currentPath]);

  const sourceKey = isRemote ? DT_LOCAL : DT_REMOTE;
  const canDrop = (dt: DataTransfer) => dt.types.includes(sourceKey);

  return (
    <div className="flex-1 flex flex-col border-r border-border last:border-r-0 overflow-hidden relative">
      {/* Path bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card">
        <span className="text-xs font-medium text-muted-foreground shrink-0">{title}</span>

        {!isRemote && drives && drives.length > 0 && (
          <select
            value={drives.find(d => currentPath.toUpperCase().startsWith(d.toUpperCase())) ?? drives[0]}
            onChange={(e) => onNavigate(e.target.value)}
            className="text-xs bg-input border border-border rounded px-1 py-0.5 shrink-0 w-16"
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

      {/* File list — drop target */}
      <div
        className={`flex-1 overflow-y-auto transition-colors ${dragOver ? "bg-primary/5 ring-1 ring-inset ring-primary/30" : ""}`}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, null); }}
        onDragEnter={(e) => {
          if (!canDrop(e.dataTransfer)) return;
          e.preventDefault();
          dragCounter.current++;
          setDragOver(true);
        }}
        onDragLeave={() => {
          dragCounter.current--;
          if (dragCounter.current === 0) setDragOver(false);
        }}
        onDragOver={(e) => {
          if (!canDrop(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          if (!canDrop(e.dataTransfer)) return;
          e.preventDefault();
          dragCounter.current = 0;
          setDragOver(false);
          const raw = e.dataTransfer.getData(sourceKey);
          if (raw) onDrop(JSON.parse(raw) as DragPayload);
        }}
      >
        {loading && (
          <div className="px-3 py-2 text-xs text-muted-foreground animate-pulse">Loading…</div>
        )}

        {/* Parent directory (..) */}
        {(isRemote ? currentPath !== "/" : currentPath.length > 3) && (
          <div
            className="flex items-center gap-2 px-3 py-0.5 cursor-pointer hover:bg-accent/50 text-muted-foreground"
            onDoubleClick={() => {
              let parent: string;
              if (isRemote) {
                parent = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
              } else {
                const p = currentPath.replace(/[/\\]$/, "");
                const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
                parent = idx > 2 ? p.slice(0, idx) + "/" : p.slice(0, 3);
              }
              onNavigate(parent);
            }}
          >
            <span>📁</span>
            <span className="text-xs">..</span>
          </div>
        )}

        {files.map((file) => {
          const isSel = selected.has(file.path);
          return (
            <div
              key={file.path}
              draggable
              onDragStart={(e) => {
                // Drag selected set if this file is selected, otherwise just this file
                const dragFiles = isSel && selected.size > 1
                  ? files.filter(f => selected.has(f.path))
                  : [file];
                const key = isRemote ? DT_REMOTE : DT_LOCAL;
                e.dataTransfer.setData(key, JSON.stringify({ files: dragFiles, isRemote }));
                e.dataTransfer.effectAllowed = "move";
              }}
              className={`flex items-center gap-2 px-3 py-0.5 cursor-pointer select-none ${
                isSel ? "bg-primary/25 text-foreground" : "hover:bg-accent/50"
              }`}
              onClick={(e) => onSelect(file, e.ctrlKey || e.metaKey, e.shiftKey)}
              onDoubleClick={() => {
                if (file.is_dir) {
                  onNavigate(file.path.replace(/[/\\]$/, "") + "/");
                } else if (isRemote && onOpen) {
                  onOpen(file);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                // Include in selection if not already
                onContextMenu(e, file);
              }}
            >
              <span className="text-sm shrink-0">{file.is_dir ? "📁" : getFileIcon(file.name)}</span>
              <span className="flex-1 text-xs truncate">{file.name}</span>
              <span className="w-20 text-right text-xs text-muted-foreground shrink-0">
                {file.is_dir ? "" : formatSize(file.size)}
              </span>
            </div>
          );
        })}

        {!loading && files.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">Empty directory</div>
        )}
      </div>

      {/* Drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
          <div className="bg-primary/10 border-2 border-dashed border-primary rounded-xl px-8 py-6 text-sm text-primary font-semibold backdrop-blur-sm">
            {isRemote ? "↑ Drop here → Upload" : "↓ Drop here → Download"}
          </div>
        </div>
      )}

      {/* Selection count badge */}
      {selected.size > 1 && (
        <div className="absolute bottom-2 right-2 bg-primary text-primary-foreground text-xs rounded-full px-2 py-0.5 pointer-events-none">
          {selected.size} selected
        </div>
      )}
    </div>
  );
}

// ── FilePanels (parent) ──────────────────────────────────────────────────────

export function FilePanels() {
  const { activeSessionId } = useSessionStore();
  const { openTab } = useEditorStore();
  const queryClient = useQueryClient();
  const { settings } = useSettingsStore();

  // Persist last local path
  const [localPath, setLocalPathRaw] = useState(() =>
    localStorage.getItem("ftpie-local-path") ?? "C:/"
  );
  const setLocalPath = useCallback((p: string) => {
    localStorage.setItem("ftpie-local-path", p);
    setLocalPathRaw(p);
  }, []);

  const [remotePath, setRemotePath] = useState("/");
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set());
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set());
  const localAnchorRef = useRef<string | null>(null);
  const remoteAnchorRef = useRef<string | null>(null);
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const [drives, setDrives] = useState<string[]>([]);
  const [transferMsg, setTransferMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number; y: number;
    file: FileEntry | null;
    isRemote: boolean;
  } | null>(null);

  useEffect(() => {
    invoke<string[]>("list_drives").then(setDrives).catch(() => {});
  }, []);

  const { data: localFiles = [], isFetching: localLoading } = useQuery({
    queryKey: ["local", localPath],
    queryFn: () => invoke<FileEntry[]>("list_local", { path: localPath }),
  });

  const { data: remoteFiles = [], isFetching: remoteLoading } = useQuery({
    queryKey: ["remote", remotePath, activeSessionId],
    queryFn: () =>
      invoke<FileEntry[]>("list_remote", { sessionId: activeSessionId ?? "", path: remotePath }),
    enabled: !!activeSessionId,
  });

  const showMsg = (text: string, ok: boolean) => {
    setTransferMsg({ text, ok });
    setTimeout(() => setTransferMsg(null), 4000);
  };

  // ── Multi-select handler ───────────────────────────────────────────────────

  const makeSelectHandler = (
    fileList: FileEntry[],
    sel: Set<string>,
    setSel: (s: Set<string>) => void,
    anchor: React.MutableRefObject<string | null>
  ) => (file: FileEntry, ctrl: boolean, shift: boolean) => {
    if (shift && anchor.current) {
      const paths = fileList.map(f => f.path);
      const ai = paths.indexOf(anchor.current);
      const ci = paths.indexOf(file.path);
      if (ai >= 0) {
        const [lo, hi] = ai < ci ? [ai, ci] : [ci, ai];
        setSel(new Set(paths.slice(lo, hi + 1)));
        return;
      }
    }
    if (ctrl) {
      const next = new Set(sel);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      setSel(next);
    } else {
      setSel(new Set([file.path]));
    }
    anchor.current = file.path;
  };

  // ── Recursive transfer helpers ─────────────────────────────────────────────

  const downloadDirRecursive = async (remPath: string, localBase: string) => {
    if (!activeSessionId) return;
    await invoke("mkdir_local", { path: localBase });
    const entries = await invoke<FileEntry[]>("list_remote", { sessionId: activeSessionId, path: remPath });
    for (const f of entries) {
      if (f.is_dir) {
        await downloadDirRecursive(f.path, localBase + "/" + f.name);
      } else {
        await invoke("download", { sessionId: activeSessionId, remotePath: f.path, localPath: localBase + "/" + f.name });
      }
    }
  };

  const uploadDirRecursive = async (locPath: string, remBase: string) => {
    if (!activeSessionId) return;
    await invoke("mkdir_remote", { sessionId: activeSessionId, path: remBase });
    const entries = await invoke<FileEntry[]>("list_local", { path: locPath });
    for (const f of entries) {
      if (f.is_dir) {
        await uploadDirRecursive(f.path, remBase + "/" + f.name);
      } else {
        await invoke("upload", { sessionId: activeSessionId, localPath: f.path, remotePath: remBase + "/" + f.name });
      }
    }
  };

  // ── Transfer operations ────────────────────────────────────────────────────

  const transferFiles = async (files: FileEntry[], fromRemote: boolean) => {
    if (!activeSessionId) { showMsg("Connect to a server first", false); return; }
    showMsg(`${fromRemote ? "↓ Downloading" : "↑ Uploading"} ${files.length} item(s)…`, true);
    try {
      for (const file of files) {
        if (fromRemote) {
          const dest = localPath.replace(/[/\\]$/, "") + "/" + file.name;
          if (file.is_dir) {
            await downloadDirRecursive(file.path, dest);
          } else {
            await invoke("download", { sessionId: activeSessionId, remotePath: file.path, localPath: dest });
          }
        } else {
          const dest = remotePath.replace(/\/$/, "") + "/" + file.name;
          if (file.is_dir) {
            await uploadDirRecursive(file.path, dest);
          } else {
            await invoke("upload", { sessionId: activeSessionId, localPath: file.path, remotePath: dest });
          }
        }
      }
      queryClient.invalidateQueries({ queryKey: [fromRemote ? "local" : "remote"] });
      showMsg(`✓ Done: ${files.length} item(s)`, true);
    } catch (err) {
      showMsg(`Error: ${err}`, false);
    }
  };

  const handleDrop = (payload: DragPayload) =>
    transferFiles(payload.files, payload.isRemote);

  // ── Editor open ────────────────────────────────────────────────────────────

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

  // ── Context menu builder ───────────────────────────────────────────────────

  const buildMenuItems = (file: FileEntry | null, isRemote: boolean, sel: Set<string>, fileList: FileEntry[]): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    const selectedFiles = fileList.filter(f => sel.has(f.path));
    const multi = selectedFiles.length > 1;

    if (file) {
      // Transfer action
      if (isRemote) {
        items.push({
          label: file.is_dir ? "Download Folder" : "Download",
          icon: "↓",
          disabled: !activeSessionId,
          onClick: () => transferFiles([file], true),
        });
        if (!file.is_dir) {
          items.push({ label: "Open in Editor", icon: "✎", disabled: !activeSessionId, onClick: () => openInEditor(file) });
        }
      } else {
        items.push({
          label: file.is_dir ? "Upload Folder" : "Upload",
          icon: "↑",
          disabled: !activeSessionId,
          onClick: () => transferFiles([file], false),
        });
      }

      // Bulk transfer for selection
      if (multi) {
        items.push({
          label: `${isRemote ? "Download" : "Upload"} ${selectedFiles.length} selected`,
          icon: isRemote ? "↓" : "↑",
          disabled: !activeSessionId,
          onClick: () => transferFiles(selectedFiles, isRemote),
        });
      }

      items.push({ separator: true });

      // Rename
      items.push({
        label: "Rename",
        icon: "✎",
        onClick: async () => {
          const newName = prompt("New name:", file.name);
          if (!newName || newName === file.name) return;
          try {
            if (isRemote) {
              const newPath = file.path.replace(/[^/\\]+$/, newName);
              await invoke("rename_remote", { sessionId: activeSessionId, from: file.path, to: newPath });
              queryClient.invalidateQueries({ queryKey: ["remote", remotePath, activeSessionId] });
            } else {
              const newPath = file.path.replace(/[^/\\]+$/, newName);
              await invoke("rename_local", { from: file.path, to: newPath });
              queryClient.invalidateQueries({ queryKey: ["local", localPath] });
            }
          } catch (err) { showMsg(`Rename failed: ${err}`, false); }
        },
      });

      // Delete
      items.push({
        label: multi ? `Delete ${selectedFiles.length} items` : "Delete",
        icon: "✕",
        danger: true,
        onClick: async () => {
          const targets = multi ? selectedFiles : [file];
          if (!confirm(`Delete ${targets.length} item(s)?`)) return;
          try {
            for (const f of targets) {
              if (isRemote) {
                await invoke("delete_remote", { sessionId: activeSessionId, path: f.path, isDir: f.is_dir });
              } else {
                await invoke("delete_local", { path: f.path, isDir: f.is_dir });
              }
            }
            if (isRemote) queryClient.invalidateQueries({ queryKey: ["remote", remotePath, activeSessionId] });
            else queryClient.invalidateQueries({ queryKey: ["local", localPath] });
            if (isRemote) setRemoteSelected(new Set());
            else setLocalSelected(new Set());
          } catch (err) { showMsg(`Delete failed: ${err}`, false); }
        },
      });
    }

    // New Folder & Refresh (always)
    items.push({ separator: true });
    items.push({
      label: "New Folder",
      icon: "📁",
      onClick: async () => {
        const name = prompt("Folder name:");
        if (!name) return;
        try {
          if (isRemote) {
            await invoke("mkdir_remote", { sessionId: activeSessionId, path: remotePath.replace(/\/$/, "") + "/" + name });
            queryClient.invalidateQueries({ queryKey: ["remote", remotePath, activeSessionId] });
          } else {
            await invoke("mkdir_local", { path: localPath.replace(/[/\\]$/, "") + "/" + name });
            queryClient.invalidateQueries({ queryKey: ["local", localPath] });
          }
        } catch (err) { showMsg(`Failed: ${err}`, false); }
      },
    });
    items.push({
      label: "Refresh",
      icon: "↻",
      onClick: () => {
        if (isRemote) queryClient.invalidateQueries({ queryKey: ["remote", remotePath, activeSessionId] });
        else queryClient.invalidateQueries({ queryKey: ["local", localPath] });
      },
    });

    return items;
  };

  // ── Context menu handler ───────────────────────────────────────────────────

  const handleContextMenu = (isRemote: boolean) => (e: React.MouseEvent, file: FileEntry | null) => {
    e.preventDefault();
    // If right-clicked file is not in selection, select just it
    if (file) {
      const sel = isRemote ? remoteSelected : localSelected;
      if (!sel.has(file.path)) {
        if (isRemote) setRemoteSelected(new Set([file.path]));
        else setLocalSelected(new Set([file.path]));
      }
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, file, isRemote });
  };

  const visibleRemoteFiles = settings.showHiddenFiles
    ? remoteFiles
    : remoteFiles.filter(f => !f.name.startsWith("."));

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {transferMsg && (
        <div className={`px-4 py-1 text-xs border-b shrink-0 ${transferMsg.ok ? "bg-green-950/30 text-green-300 border-green-900/40" : "bg-red-950/30 text-red-400 border-red-900/40"}`}>
          {transferMsg.text}
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <FilePanel
          title="Local"
          files={localFiles}
          currentPath={localPath}
          onNavigate={setLocalPath}
          selected={localSelected}
          onSelect={makeSelectHandler(localFiles, localSelected, setLocalSelected, localAnchorRef)}
          isRemote={false}
          loading={localLoading}
          drives={drives}
          onDrop={handleDrop}
          onContextMenu={handleContextMenu(false)}
        />
        <FilePanel
          title={activeSessionId ? "Remote" : "Remote (not connected)"}
          files={visibleRemoteFiles}
          currentPath={remotePath}
          onNavigate={setRemotePath}
          selected={remoteSelected}
          onSelect={makeSelectHandler(visibleRemoteFiles, remoteSelected, setRemoteSelected, remoteAnchorRef)}
          onOpen={openInEditor}
          isRemote={true}
          loading={remoteLoading || !!openingFile}
          onDrop={handleDrop}
          onContextMenu={handleContextMenu(true)}
        />
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={buildMenuItems(
            ctxMenu.file,
            ctxMenu.isRemote,
            ctxMenu.isRemote ? remoteSelected : localSelected,
            ctxMenu.isRemote ? visibleRemoteFiles : localFiles
          )}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
