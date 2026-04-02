import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useSessionStore } from "../store/sessionStore";

interface AiAction {
  type: string;
  from?: string;
  to?: string;
  path?: string;
  reason?: string;
  mode?: string;
  local?: string;
  remote?: string;
  source?: string;
  description?: string;
}

interface AiResponse {
  message: string;
  actions: AiAction[];
}

interface Message {
  role: "user" | "assistant";
  content: string;
  actions?: AiAction[];
}

interface AiSettings {
  provider: "claude" | "openai" | "ollama";
  apiKey: string;
  model: string;
}

interface Props {
  onClose: () => void;
  currentRemotePath?: string;
  selectedFiles?: string[];
}

const ACTION_LABELS: Record<string, string> = {
  rename_file: "Rename",
  delete_file: "Delete",
  create_directory: "Create Dir",
  move_file: "Move",
  change_permissions: "chmod",
  upload_file: "Upload",
  run_script: "Run Script",
};

export function AiAssistant({ onClose, currentRemotePath, selectedFiles = [] }: Props) {
  const { activeSessionId } = useSessionStore();
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Merhaba! Dosya yönetimi, yeniden adlandırma, deployment önerileri ve daha fazlası için buradayım. Ne yapmak istersiniz?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<AiSettings>({
    provider: "claude",
    apiKey: "",
    model: "",
  });
  const [showSettings, setShowSettings] = useState(false);
  const [applyingAction, setApplyingAction] = useState<string | null>(null);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || loading) return;

    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setInput("");
    setLoading(true);

    try {
      const response = await invoke<AiResponse>("ai_query", {
        args: {
          prompt,
          provider: settings.provider,
          api_key: settings.apiKey || null,
          model: settings.model || null,
          context: {
            remote_path: currentRemotePath ?? null,
            local_path: null,
            selected_files: selectedFiles,
            git_branch: null,
            file_listing: null,
          },
        },
      });

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: response.message,
          actions: response.actions.length > 0 ? response.actions : undefined,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Hata: ${err}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const applyAction = async (action: AiAction) => {
    if (!activeSessionId) {
      alert("No active FTP session");
      return;
    }
    const key = JSON.stringify(action);
    setApplyingAction(key);
    try {
      const result = await invoke<string>("ai_apply_action", {
        action,
        sessionId: activeSessionId,
      });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `✓ ${result}` },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `✗ Action failed: ${err}` },
      ]);
    } finally {
      setApplyingAction(null);
    }
  };

  return (
    <div className="w-72 border-l border-border bg-card flex flex-col text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="font-medium">✨ AI Assistant</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="text-xs text-muted-foreground hover:text-foreground"
            title="Settings"
          >
            ⚙
          </button>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            ×
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="border-b border-border p-3 space-y-2 bg-card">
          <div>
            <label className="text-xs text-muted-foreground">Provider</label>
            <select
              value={settings.provider}
              onChange={(e) => setSettings({ ...settings, provider: e.target.value as any })}
              className="w-full mt-0.5 bg-input border border-border rounded px-2 py-1 text-xs"
            >
              <option value="claude">Anthropic Claude</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (Local)</option>
            </select>
          </div>
          {settings.provider !== "ollama" && (
            <div>
              <label className="text-xs text-muted-foreground">API Key</label>
              <input
                type="password"
                value={settings.apiKey}
                onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                placeholder="sk-..."
                className="w-full mt-0.5 bg-input border border-border rounded px-2 py-1 text-xs"
              />
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground">Model (optional)</label>
            <input
              type="text"
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              placeholder={settings.provider === "claude" ? "claude-sonnet-4-6" : "gpt-4o"}
              className="w-full mt-0.5 bg-input border border-border rounded px-2 py-1 text-xs"
            />
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.map((msg, i) => (
          <div key={i}>
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground ml-6"
                  : "bg-muted mr-6"
              }`}
            >
              {msg.content}
            </div>

            {/* Action proposals */}
            {msg.actions && msg.actions.length > 0 && (
              <div className="mt-2 space-y-1 mr-6">
                {msg.actions.map((action, j) => {
                  const key = JSON.stringify(action);
                  const label = ACTION_LABELS[action.type] ?? action.type;
                  const isApplying = applyingAction === key;
                  return (
                    <div
                      key={j}
                      className="border border-border rounded-lg px-3 py-2 text-xs bg-background"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-primary">{label}</span>
                        <button
                          onClick={() => applyAction(action)}
                          disabled={isApplying}
                          className="px-2 py-0.5 bg-green-600 text-white rounded text-xs hover:bg-green-500 disabled:opacity-50 shrink-0"
                        >
                          {isApplying ? "…" : "Apply"}
                        </button>
                      </div>
                      {action.from && action.to && (
                        <div className="mt-1 font-mono text-muted-foreground truncate">
                          {action.from} → {action.to}
                        </div>
                      )}
                      {action.path && (
                        <div className="mt-1 font-mono text-muted-foreground truncate">
                          {action.path}
                        </div>
                      )}
                      {action.reason && (
                        <div className="mt-1 text-muted-foreground italic">{action.reason}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="bg-muted rounded-lg px-3 py-2 text-xs mr-6 text-muted-foreground animate-pulse">
            Thinking…
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask anything…"
          className="flex-1 text-xs bg-input border border-border rounded px-2 py-1.5"
          disabled={loading}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-2 py-1.5 text-xs bg-violet-600 text-white rounded hover:bg-violet-500 disabled:opacity-50 shrink-0"
        >
          Send
        </button>
      </div>
    </div>
  );
}
