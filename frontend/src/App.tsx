import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionBar } from "./components/ConnectionBar";
import { FilePanels } from "./components/FilePanels";
import { TransferQueue } from "./components/TransferQueue";
import { StatusBar } from "./components/StatusBar";
import { Sidebar } from "./components/Sidebar";
import { AiAssistant } from "./components/AiAssistant";
import { EditorPane } from "./components/EditorPane";
import { GitPanel } from "./components/GitPanel";
import { ScriptManager } from "./components/ScriptManager";
import { CollaborationPanel } from "./components/CollaborationPanel";
import { useSessionStore } from "./store/sessionStore";
import { useSettingsStore } from "./store/settingsStore";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5000 },
  },
});

export default function App() {
  const [aiOpen, setAiOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const { activeSessionId } = useSessionStore();
  const { settings } = useSettingsStore();

  useEffect(() => {
    const html = document.documentElement;
    const theme = settings.theme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : settings.theme;
    html.classList.toggle("dark", theme === "dark");
    html.classList.toggle("light", theme === "light");
  }, [settings.theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden select-none">
        {/* Top bar */}
        <ConnectionBar
          onAiClick={() => setAiOpen((v) => !v)}
          onScriptClick={() => setScriptOpen(true)}
          onGitClick={() => setGitOpen((v) => !v)}
          onCollabClick={() => setCollabOpen((v) => !v)}
        />

        {/* Main area */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar: bookmarks */}
          <Sidebar />

          {/* Center column */}
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {/* File panels take remaining space above editor */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <FilePanels />
              <TransferQueue />
            </div>

            {/* Monaco editor pane — only shown when tabs are open */}
            <EditorPane />
          </div>

          {/* Right panels — stacked side panels */}
          <div className="flex">
            {gitOpen && (
              <GitPanel onClose={() => setGitOpen(false)} />
            )}
            {collabOpen && (
              <CollaborationPanel onClose={() => setCollabOpen(false)} />
            )}
            {aiOpen && (
              <AiAssistant
                onClose={() => setAiOpen(false)}
                currentRemotePath={undefined}
                selectedFiles={[]}
              />
            )}
          </div>
        </div>

        {/* Status bar */}
        <StatusBar />

        {/* Script Manager modal */}
        {scriptOpen && <ScriptManager onClose={() => setScriptOpen(false)} />}
      </div>
    </QueryClientProvider>
  );
}
