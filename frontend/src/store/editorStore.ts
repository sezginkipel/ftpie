/**
 * Remote-file editor tabs.
 *
 * Fixes carried by this store:
 * - Reopening an already-open file no longer silently discards the freshly
 *   fetched content: a clean tab is refreshed, a dirty tab reports the conflict
 *   so the user chooses.
 * - Closing a session closes its tabs, instead of leaving tabs pointing at a
 *   dead session id.
 * - Saves send `expectedHash`, and a `conflict` rejection is handed back to the
 *   caller so the save-conflict dialog can open. The tab stays dirty.
 * - **A binary tab is read-only.** The old editor could corrupt a binary by
 *   round-tripping base64 through a text buffer and saving it back.
 */
import { create } from 'zustand';

import { call, errorCode } from '../lib/ipc';
import type { OpenedFile, SaveResult } from '../lib/types';

export interface EditorTab {
  /** `${sessionId}:${remotePath}` — one tab per file per session. */
  id: string;
  sessionId: string;
  remotePath: string;
  fileName: string;
  content: string;
  /** Content as last seen on the server; `dirty` is derived from this. */
  originalContent: string;
  /** SHA-256 from the server, sent back as `expectedHash` on save. */
  originalHash: string;
  isBinary: boolean;
  encoding: string;
  size: number;
  dirty: boolean;
  saving: boolean;
  /** Last save failure, so the pane can show an inline banner. */
  saveError: unknown;
}

/** Raised by `open` when a dirty tab for the same file already exists. */
export interface ReopenConflict {
  kind: 'reopen-conflict';
  tabId: string;
  /** Content just fetched from the server, ready to apply on "reload". */
  fetched: OpenedFile;
}

export function isReopenConflict(value: unknown): value is ReopenConflict {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ReopenConflict).kind === 'reopen-conflict'
  );
}

function tabId(sessionId: string, remotePath: string): string {
  return `${sessionId}:${remotePath}`;
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

function tabFrom(sessionId: string, remotePath: string, file: OpenedFile): EditorTab {
  return {
    id: tabId(sessionId, remotePath),
    sessionId,
    remotePath,
    fileName: baseName(remotePath),
    content: file.content,
    originalContent: file.content,
    originalHash: file.hash,
    isBinary: file.isBinary,
    encoding: file.encoding,
    size: file.size,
    dirty: false,
    saving: false,
    saveError: null,
  };
}

interface EditorState {
  tabs: EditorTab[];
  activeId: string | null;

  // ── Reads ──
  active: () => EditorTab | null;
  byId: (id: string) => EditorTab | null;
  /** Tabs with unsaved edits — the close guard reads this. */
  dirtyTabs: () => EditorTab[];

  // ── Mutations ──
  /**
   * Open a remote file.
   *
   * A clean already-open tab is refreshed from the server and focused. A dirty
   * one rejects with a {@link ReopenConflict} carrying the fetched content, so
   * the UI can offer "keep mine" / "reload".
   */
  open: (sessionId: string, remotePath: string) => Promise<EditorTab>;
  /** Replace a tab's content with a fetched version, discarding local edits. */
  applyFetched: (tabId: string, file: OpenedFile) => void;
  setActive: (tabId: string) => void;
  /** Edit the buffer. Ignored for a binary tab, which is read-only. */
  setContent: (tabId: string, content: string) => void;
  close: (tabId: string) => void;
  /** Drop every tab belonging to a session — call this from `disconnect`. */
  closeSession: (sessionId: string) => void;
  /**
   * Save. Sends `expectedHash`; a `conflict` rejection is re-thrown for the
   * save-conflict dialog and the tab stays dirty.
   */
  save: (tabId: string, options?: { force?: boolean }) => Promise<SaveResult>;
  /** Discard local edits and reload from the server. */
  revert: (tabId: string) => Promise<void>;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeId: null,

  active() {
    const { activeId, tabs } = get();
    return activeId ? (tabs.find((tab) => tab.id === activeId) ?? null) : null;
  },

  byId(id) {
    return get().tabs.find((tab) => tab.id === id) ?? null;
  },

  dirtyTabs() {
    return get().tabs.filter((tab) => tab.dirty);
  },

  async open(sessionId, remotePath) {
    const id = tabId(sessionId, remotePath);
    const file = await call<OpenedFile>('editor_open_file', { sessionId, remotePath });
    const existing = get().byId(id);

    if (existing?.dirty) {
      // Never throw away either version silently.
      const conflict: ReopenConflict = { kind: 'reopen-conflict', tabId: id, fetched: file };
      throw conflict;
    }

    const tab = tabFrom(sessionId, remotePath, file);
    set((state) => ({
      tabs: existing
        ? state.tabs.map((candidate) => (candidate.id === id ? tab : candidate))
        : [...state.tabs, tab],
      activeId: id,
    }));
    return tab;
  },

  applyFetched(id, file) {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id
          ? {
              ...tab,
              content: file.content,
              originalContent: file.content,
              originalHash: file.hash,
              isBinary: file.isBinary,
              encoding: file.encoding,
              size: file.size,
              dirty: false,
              saveError: null,
            }
          : tab,
      ),
      activeId: id,
    }));
  },

  setActive(id) {
    if (!get().byId(id)) return;
    set({ activeId: id });
  },

  setContent(id, content) {
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        if (tab.id !== id) return tab;
        // A binary buffer is base64 in a text editor; letting it be edited is
        // how a saved file ends up corrupt.
        if (tab.isBinary) return tab;
        return { ...tab, content, dirty: content !== tab.originalContent };
      }),
    }));
  },

  close(id) {
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.id !== id);
      const activeId =
        state.activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : state.activeId;
      return { tabs, activeId };
    });
  },

  closeSession(sessionId) {
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId);
      const activeId =
        state.activeId && tabs.some((tab) => tab.id === state.activeId)
          ? state.activeId
          : (tabs[tabs.length - 1]?.id ?? null);
      return { tabs, activeId };
    });
  },

  async save(id, options) {
    const tab = get().byId(id);
    if (!tab) throw { code: 'not_found', path: id, message: `editor tab ${id} not found` };
    if (tab.isBinary) {
      throw {
        code: 'config',
        message: 'A binary file is opened read-only and cannot be saved.',
      };
    }

    const patch = (changes: Partial<EditorTab>) =>
      set((state) => ({
        tabs: state.tabs.map((candidate) =>
          candidate.id === id ? { ...candidate, ...changes } : candidate,
        ),
      }));

    patch({ saving: true, saveError: null });

    try {
      const result = await call<SaveResult>('editor_save_file', {
        args: {
          sessionId: tab.sessionId,
          remotePath: tab.remotePath,
          content: tab.content,
          isBinary: false,
          // `force` skips the optimistic check — used only after the user
          // explicitly chose "overwrite" in the conflict dialog.
          expectedHash: options?.force ? null : tab.originalHash,
        },
      });

      patch({
        saving: false,
        dirty: false,
        originalContent: tab.content,
        originalHash: result.hash,
        size: result.bytes,
        saveError: null,
      });
      return result;
    } catch (error) {
      // The tab stays dirty on every failure. A `conflict` is re-thrown so the
      // caller can open the save-conflict dialog; anything else is a toast.
      patch({ saving: false, saveError: error });
      if (errorCode(error) === 'conflict') throw error;
      throw error;
    }
  },

  async revert(id) {
    const tab = get().byId(id);
    if (!tab) return;
    const file = await call<OpenedFile>('editor_open_file', {
      sessionId: tab.sessionId,
      remotePath: tab.remotePath,
    });
    get().applyFetched(id, file);
  },
}));
