import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  onClose: () => void;
}

export function AiAssistant({ onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Hello! I can help you manage your files, suggest deployment strategies, rename files in bulk, and more. What would you like to do?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || loading) return;

    const userMsg: Message = { role: "user", content: prompt };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const result = await invoke<{ message: string; actions: unknown[] }>(
        "ai_query",
        {
          args: {
            prompt,
            provider: "claude",
            context: null,
          },
        }
      );

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.message },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-72 border-l border-border bg-card flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-sm font-medium">✨ AI Assistant</span>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none"
        >
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-sm">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 ${
              msg.role === "user"
                ? "bg-primary text-primary-foreground ml-4"
                : "bg-muted mr-4"
            }`}
          >
            {msg.content}
          </div>
        ))}
        {loading && (
          <div className="bg-muted rounded-lg px-3 py-2 mr-4 text-muted-foreground animate-pulse">
            Thinking...
          </div>
        )}
      </div>

      <div className="p-3 border-t border-border flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Ask anything..."
          className="flex-1 text-sm bg-input border border-border rounded px-2 py-1"
          disabled={loading}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="px-3 py-1 text-sm bg-violet-600 text-white rounded hover:bg-violet-500 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
