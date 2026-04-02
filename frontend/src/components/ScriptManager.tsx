import Editor from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface Script {
  id: string;
  name: string;
  description: string;
  source: string;
  created_at: string;
  last_run?: string;
}

interface ScriptLog {
  timestamp: string;
  level: string;
  message: string;
}

interface RunResult {
  logs: ScriptLog[];
  return_value: string;
  success: boolean;
  error?: string;
}

interface ValidateResult {
  valid: boolean;
  errors: string[];
}

export function ScriptManager({ onClose }: { onClose: () => void }) {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [selected, setSelected] = useState<Script | null>(null);
  const [source, setSource] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    loadScripts();
  }, []);

  const loadScripts = async () => {
    const list = await invoke<Script[]>("list_scripts");
    setScripts(list);
    if (list.length > 0 && !selected) {
      selectScript(list[0]);
    }
  };

  const selectScript = (script: Script) => {
    setSelected(script);
    setSource(script.source);
    setIsDirty(false);
    setResult(null);
    setValidation(null);
  };

  const validate = async () => {
    const v = await invoke<ValidateResult>("validate_script", { source });
    setValidation(v);
  };

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const r = await invoke<RunResult>("run_script", { source });
      setResult(r);
    } finally {
      setRunning(false);
    }
  };

  const save = async () => {
    if (!selected) return;
    const updated = { ...selected, source };
    await invoke("save_script", { script: updated });
    setIsDirty(false);
    await loadScripts();
  };

  const newScript = async () => {
    const script: Script = {
      id: crypto.randomUUID(),
      name: "New Script",
      description: "",
      source: '// ftpie Rhai script\nlog("Hello from ftpie!");\n',
      created_at: new Date().toISOString(),
    };
    await invoke("save_script", { script });
    await loadScripts();
    selectScript(script);
  };

  const deleteScript = async (id: string) => {
    if (!confirm("Delete this script?")) return;
    await invoke("delete_script", { id });
    setSelected(null);
    setSource("");
    await loadScripts();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-background border border-border rounded-lg w-[900px] h-[600px] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <span className="font-medium text-sm">Script Manager</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none">×</button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Script list */}
          <div className="w-52 border-r border-border flex flex-col">
            <div className="p-2 border-b border-border">
              <button
                onClick={newScript}
                className="w-full text-xs px-2 py-1 bg-primary text-primary-foreground rounded hover:bg-primary/90"
              >
                + New Script
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {scripts.map((s) => (
                <div
                  key={s.id}
                  className={`group flex items-center justify-between px-3 py-2 cursor-pointer text-sm ${
                    selected?.id === s.id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                  onClick={() => selectScript(s)}
                >
                  <span className="truncate">{s.name}</span>
                  <button
                    className="hidden group-hover:block text-muted-foreground hover:text-red-400 text-xs"
                    onClick={(e) => { e.stopPropagation(); deleteScript(s.id); }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Editor + output */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selected ? (
              <>
                {/* Toolbar */}
                <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card">
                  <input
                    type="text"
                    value={selected.name}
                    onChange={(e) => {
                      setSelected({ ...selected, name: e.target.value });
                      setIsDirty(true);
                    }}
                    className="text-sm bg-input border border-border rounded px-2 py-0.5 w-48"
                  />
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      onClick={validate}
                      className="text-xs px-2 py-1 border border-border rounded hover:bg-accent"
                    >
                      Validate
                    </button>
                    <button
                      onClick={save}
                      disabled={!isDirty}
                      className="text-xs px-2 py-1 border border-border rounded hover:bg-accent disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      onClick={run}
                      disabled={running}
                      className="text-xs px-3 py-1 bg-green-600 text-white rounded hover:bg-green-500 disabled:opacity-50"
                    >
                      {running ? "Running…" : "▶ Run"}
                    </button>
                  </div>
                </div>

                {/* Monaco */}
                <div style={{ flex: "1 1 0", minHeight: 0 }}>
                  <Editor
                    height="100%"
                    language="javascript"
                    value={source}
                    theme="vs-dark"
                    onChange={(v) => {
                      if (v !== undefined) { setSource(v); setIsDirty(true); }
                    }}
                    options={{
                      fontSize: 13,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                    }}
                  />
                </div>

                {/* Output */}
                {(result || validation) && (
                  <div className="border-t border-border p-3 overflow-y-auto max-h-40 text-xs font-mono">
                    {validation && !validation.valid && (
                      <div className="text-red-400">
                        {validation.errors.map((e, i) => <div key={i}>✗ {e}</div>)}
                      </div>
                    )}
                    {validation?.valid && (
                      <div className="text-green-400">✓ Syntax OK</div>
                    )}
                    {result && (
                      <div className="space-y-0.5">
                        {result.logs.map((log, i) => (
                          <div key={i} className={`${log.level === "error" ? "text-red-400" : log.level === "warn" ? "text-yellow-400" : "text-muted-foreground"}`}>
                            [{log.timestamp.slice(11, 19)}] {log.message}
                          </div>
                        ))}
                        {result.error && (
                          <div className="text-red-400">Error: {result.error}</div>
                        )}
                        {result.success && (
                          <div className="text-green-400">✓ Completed</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Select or create a script
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
