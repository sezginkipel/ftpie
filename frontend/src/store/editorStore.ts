import { create } from "zustand";

export interface EditorTab {
  id: string;
  sessionId: string;
  remotePath: string;
  /** Dosya adı (path'in son segmenti) */
  name: string;
  content: string;
  originalContent: string;
  originalHash: string;
  language: string;
  isDirty: boolean;
  isSaving: boolean;
  isBinary: boolean;
}

interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;

  /** Sekme aç (varsa aktive et) */
  openTab: (tab: Omit<EditorTab, "isDirty" | "isSaving">) => void;
  /** Aktif sekmeyi değiştir */
  setActive: (id: string) => void;
  /** Sekme içeriğini güncelle (dirty flag'i set eder) */
  updateContent: (id: string, content: string) => void;
  /** Kayıt başladı */
  setSaving: (id: string, saving: boolean) => void;
  /** Başarılı kayıt — dirty temizle, original güncelle */
  markSaved: (id: string, newHash: string) => void;
  /** Sekmeyi kapat */
  closeTab: (id: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab(tab) {
    const existing = get().tabs.find((t) => t.remotePath === tab.remotePath && t.sessionId === tab.sessionId);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }
    const newTab: EditorTab = { ...tab, isDirty: false, isSaving: false };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: newTab.id,
    }));
  },

  setActive(id) {
    set({ activeTabId: id });
  },

  updateContent(id, content) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, content, isDirty: content !== t.originalContent }
          : t
      ),
    }));
  },

  setSaving(id, saving) {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, isSaving: saving } : t)),
    }));
  },

  markSaved(id, newHash) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, isDirty: false, isSaving: false, originalHash: newHash, originalContent: t.content }
          : t
      ),
    }));
  },

  closeTab(id) {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    const newTabs = tabs.filter((t) => t.id !== id);
    let newActive = activeTabId;
    if (activeTabId === id) {
      // Sağdaki sekmeye geç, yoksa soldaki
      newActive = newTabs[idx]?.id ?? newTabs[idx - 1]?.id ?? null;
    }
    set({ tabs: newTabs, activeTabId: newActive });
  },
}));
