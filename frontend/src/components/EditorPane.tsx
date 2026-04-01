import Editor, { DiffEditor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { useEditorStore } from "../store/editorStore";

export function EditorPane() {
  const { tabs, activeTabId, setActive, updateContent, setSaving, markSaved, closeTab } =
    useEditorStore();
  const [showDiff, setShowDiff] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Ctrl+S kaydet
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeTab && activeTab.isDirty) {
          await saveFile(activeTab.id);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab]);

  const saveFile = useCallback(
    async (tabId: string) => {
      const tab = useEditorStore.getState().tabs.find((t) => t.id === tabId);
      if (!tab) return;

      setSaving(tabId, true);
      try {
        const result = await invoke<{ bytes_written: number; new_hash: string }>(
          "editor_save_file",
          {
            sessionId: tab.sessionId,
            remotePath: tab.remotePath,
            content: tab.content,
          }
        );
        markSaved(tabId, result.new_hash);
      } catch (err) {
        console.error("Save failed:", err);
        setSaving(tabId, false);
      }
    },
    [setSaving, markSaved]
  );

  if (tabs.length === 0) return null;

  return (
    <div className="flex flex-col border-t border-border" style={{ height: "45%" }}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-card overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-r border-border cursor-pointer shrink-0 ${
              tab.id === activeTabId
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
            onClick={() => setActive(tab.id)}
          >
            <span className="max-w-[120px] truncate">{tab.name}</span>
            {tab.isDirty && (
              <span className="w-2 h-2 rounded-full bg-orange-400 shrink-0" title="Unsaved changes" />
            )}
            {tab.isSaving && (
              <span className="text-[10px] text-muted-foreground">saving…</span>
            )}
            <button
              className="text-muted-foreground hover:text-foreground ml-0.5"
              onClick={(e) => {
                e.stopPropagation();
                if (tab.isDirty && !confirm(`${tab.name} has unsaved changes. Close anyway?`)) return;
                closeTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}

        {/* Toolbar */}
        {activeTab && (
          <div className="ml-auto flex items-center gap-2 px-3 shrink-0">
            <button
              className="text-xs px-2 py-0.5 border border-border rounded hover:bg-accent"
              onClick={() => setShowDiff((v) => !v)}
            >
              {showDiff ? "Editor" : "Diff"}
            </button>
            <button
              disabled={!activeTab.isDirty || activeTab.isSaving}
              className="text-xs px-2 py-0.5 bg-primary text-primary-foreground rounded disabled:opacity-40 hover:bg-primary/90"
              onClick={() => saveFile(activeTab.id)}
            >
              {activeTab.isSaving ? "Saving…" : "Save"}
            </button>
            <span className="text-xs text-muted-foreground">
              {activeTab.language}
            </span>
          </div>
        )}
      </div>

      {/* Editor area */}
      <div className="flex-1 overflow-hidden">
        {activeTab && !showDiff && (
          <Editor
            height="100%"
            language={activeTab.language}
            value={activeTab.content}
            theme="vs-dark"
            onChange={(value) => {
              if (value !== undefined) updateContent(activeTab.id, value);
            }}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              lineNumbers: "on",
              renderWhitespace: "selection",
              tabSize: 2,
              automaticLayout: true,
            }}
          />
        )}
        {activeTab && showDiff && (
          <DiffEditor
            height="100%"
            language={activeTab.language}
            original={activeTab.originalContent}
            modified={activeTab.content}
            theme="vs-dark"
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              readOnly: false,
              automaticLayout: true,
            }}
            onMount={(editor) => {
              // Diff editor'dan modified içeriği senkronize et
              const modifiedEditor = editor.getModifiedEditor();
              modifiedEditor.onDidChangeModelContent(() => {
                const val = modifiedEditor.getValue();
                updateContent(activeTab.id, val);
              });
            }}
          />
        )}
      </div>
    </div>
  );
}
