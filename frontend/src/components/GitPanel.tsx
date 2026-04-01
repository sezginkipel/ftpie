import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useSessionStore } from "../store/sessionStore";

interface GitStatus {
  branch: string;
  is_dirty: boolean;
  changed_files: Array<{ path: string; status: string }>;
  last_commit?: {
    short_hash: string;
    message: string;
    author: string;
    timestamp: string;
  };
}

interface DeployProgress {
  total: number;
  done: number;
  current_file: string;
  status: string;
}

interface DeployResult {
  uploaded: number;
  skipped: number;
  failed: number;
  files: Array<{ local_path: string; remote_path: string; status: string; size: number }>;
}

export function GitPanel() {
  const { activeSessionId } = useSessionStore();
  const [repoPath, setRepoPath] = useState<string>("");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [remotePath, setRemotePath] = useState("/var/www/html");
  const [sinceRef, setSinceRef] = useState("");
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState<DeployProgress | null>(null);
  const [result, setResult] = useState<DeployResult | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<DeployProgress>("deploy://progress", (e) => {
      setProgress(e.payload);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const loadRepo = async () => {
    if (!repoPath) return;
    setError(null);
    try {
      const [s, b] = await Promise.all([
        invoke<GitStatus>("get_git_status", { repoPath }),
        invoke<string[]>("list_branches", { repoPath }),
      ]);
      setStatus(s);
      setBranches(b);
    } catch (e) {
      setError(String(e));
    }
  };

  const pickRepo = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected) {
      setRepoPath(selected as string);
    }
  };

  const deploy = async () => {
    if (!activeSessionId) { setError("No active FTP session"); return; }
    if (!repoPath) { setError("No repository selected"); return; }
    setDeploying(true);
    setResult(null);
    setError(null);
    try {
      const r = await invoke<DeployResult>("deploy_branch", {
        args: {
          session_id: activeSessionId,
          repo_path: repoPath,
          remote_base_path: remotePath,
          since_ref: sinceRef || null,
          exclude_patterns: ["node_modules/", ".git/", "*.log", ".env"],
          dry_run: dryRun,
        },
      });
      setResult(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeploying(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-col h-full text-sm">
      {/* Repo seçimi */}
      <div className="p-3 border-b border-border space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="Repository path..."
            className="flex-1 bg-input border border-border rounded px-2 py-1 text-xs"
          />
          <button
            onClick={pickRepo}
            className="text-xs px-2 py-1 border border-border rounded hover:bg-accent"
          >
            Browse
          </button>
          <button
            onClick={loadRepo}
            className="text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90"
          >
            Load
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 px-2 py-1 text-xs bg-red-500/10 text-red-400 rounded border border-red-500/20">
          {error}
        </div>
      )}

      {status && (
        <>
          {/* Durum */}
          <div className="px-3 py-2 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono bg-accent px-1.5 py-0.5 rounded">
                {status.branch}
              </span>
              {status.is_dirty && (
                <span className="text-xs text-orange-400">● dirty</span>
              )}
            </div>
            {status.last_commit && (
              <div className="mt-1 text-xs text-muted-foreground">
                <span className="font-mono">{status.last_commit.short_hash}</span>
                {" "}{status.last_commit.message}
              </div>
            )}
          </div>

          {/* Değişen dosyalar */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Changed Files ({status.changed_files.length})
            </div>
            {status.changed_files.slice(0, 50).map((f) => (
              <div key={f.path} className="flex items-center gap-2 px-3 py-0.5">
                <StatusBadge status={f.status} />
                <span className="text-xs font-mono truncate text-muted-foreground">{f.path}</span>
              </div>
            ))}
          </div>

          {/* Deploy ayarları */}
          <div className="border-t border-border p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Deploy
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Remote Base Path</label>
              <input
                type="text"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                className="w-full mt-0.5 bg-input border border-border rounded px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Since Ref (optional — deploy only changes since this commit/tag)
              </label>
              <input
                type="text"
                value={sinceRef}
                onChange={(e) => setSinceRef(e.target.value)}
                placeholder="e.g. v1.0.0 or HEAD~5"
                className="w-full mt-0.5 bg-input border border-border rounded px-2 py-1 text-xs font-mono"
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              <span className="text-xs">Dry run (preview only)</span>
            </label>

            {/* Progress */}
            {deploying && progress && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span className="truncate font-mono">{progress.current_file}</span>
                  <span>{progress.done}/{progress.total}</span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Sonuç */}
            {result && (
              <div className="text-xs space-y-0.5 text-muted-foreground">
                <div className="text-green-400">✓ {result.uploaded} uploaded</div>
                {result.skipped > 0 && <div>○ {result.skipped} skipped (dry run)</div>}
                {result.failed > 0 && <div className="text-red-400">✗ {result.failed} failed</div>}
              </div>
            )}

            <button
              onClick={deploy}
              disabled={deploying || !activeSessionId}
              className="w-full py-1.5 text-xs bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50"
            >
              {deploying
                ? `Deploying… ${progress ? `${progress.done}/${progress.total}` : ""}`
                : dryRun
                ? "Preview Changes"
                : `Deploy → ${remotePath}`}
            </button>
          </div>
        </>
      )}

      {!status && !repoPath && (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground text-center px-4">
          Select a git repository to enable branch-aware deployment.
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; color: string }> = {
    added: { label: "A", color: "text-green-400" },
    modified: { label: "M", color: "text-yellow-400" },
    deleted: { label: "D", color: "text-red-400" },
    renamed: { label: "R", color: "text-blue-400" },
  };
  const s = map[status] ?? { label: "?", color: "text-muted-foreground" };
  return (
    <span className={`text-xs font-mono font-bold ${s.color} w-3 shrink-0`}>
      {s.label}
    </span>
  );
}
