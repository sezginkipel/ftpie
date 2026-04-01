import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

interface FileEntry {
  name: string;
  path: string;
  size: number;
  is_dir: boolean;
}

function FilePanel({
  title,
  files,
  currentPath,
  onNavigate,
  onSelect,
  selected,
}: {
  title: string;
  files: FileEntry[];
  currentPath: string;
  onNavigate: (path: string) => void;
  onSelect: (file: FileEntry) => void;
  selected: string | null;
}) {
  return (
    <div className="flex-1 flex flex-col border-r border-border last:border-r-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card text-sm font-medium">
        <span className="text-muted-foreground">{title}</span>
        <input
          type="text"
          value={currentPath}
          onChange={(e) => onNavigate(e.target.value)}
          className="flex-1 bg-input border border-border rounded px-2 py-0.5 text-xs"
        />
        <button
          onClick={() => onNavigate(currentPath)}
          className="text-xs px-2 py-0.5 border border-border rounded hover:bg-accent"
        >
          Go
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card border-b border-border">
            <tr>
              <th className="text-left px-3 py-1 font-medium text-muted-foreground text-xs">Name</th>
              <th className="text-right px-3 py-1 font-medium text-muted-foreground text-xs">Size</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr
                key={file.path}
                className={`cursor-pointer hover:bg-accent/50 ${
                  selected === file.path ? "bg-accent" : ""
                }`}
                onClick={() => onSelect(file)}
                onDoubleClick={() => file.is_dir && onNavigate(file.path)}
              >
                <td className="px-3 py-0.5 flex items-center gap-1.5">
                  <span>{file.is_dir ? "📁" : "📄"}</span>
                  <span className="truncate">{file.name}</span>
                </td>
                <td className="px-3 py-0.5 text-right text-muted-foreground text-xs">
                  {file.is_dir ? "" : formatSize(file.size)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

export function FilePanels() {
  const [localPath, setLocalPath] = useState("/");
  const [remotePath, setRemotePath] = useState("/");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [remoteSelected, setRemoteSelected] = useState<string | null>(null);

  const { data: localFiles = [] } = useQuery({
    queryKey: ["local", localPath],
    queryFn: () => invoke<FileEntry[]>("list_local", { path: localPath }),
  });

  const { data: remoteFiles = [] } = useQuery({
    queryKey: ["remote", remotePath],
    queryFn: () => invoke<FileEntry[]>("list_remote", { sessionId: "", path: remotePath }),
  });

  return (
    <div className="flex flex-1 overflow-hidden">
      <FilePanel
        title="Local"
        files={localFiles}
        currentPath={localPath}
        onNavigate={setLocalPath}
        onSelect={(f) => setLocalSelected(f.path)}
        selected={localSelected}
      />
      <FilePanel
        title="Remote"
        files={remoteFiles}
        currentPath={remotePath}
        onNavigate={setRemotePath}
        onSelect={(f) => setRemoteSelected(f.path)}
        selected={remoteSelected}
      />
    </div>
  );
}
