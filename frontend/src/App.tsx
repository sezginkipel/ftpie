import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectionBar } from "./components/ConnectionBar";
import { FilePanels } from "./components/FilePanels";
import { TransferQueue } from "./components/TransferQueue";
import { StatusBar } from "./components/StatusBar";
import { Sidebar } from "./components/Sidebar";
import { AiAssistant } from "./components/AiAssistant";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5000 },
  },
});

export default function App() {
  const [aiOpen, setAiOpen] = useState(false);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
        {/* Top bar: connection + actions */}
        <ConnectionBar onAiClick={() => setAiOpen(true)} />

        {/* Main area */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left sidebar: bookmarks, git branches */}
          <Sidebar />

          {/* Center: dual-pane file manager */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <FilePanels />
            <TransferQueue />
          </div>

          {/* Right: AI assistant panel (collapsible) */}
          {aiOpen && <AiAssistant onClose={() => setAiOpen(false)} />}
        </div>

        {/* Status bar */}
        <StatusBar />
      </div>
    </QueryClientProvider>
  );
}
