/**
 * Live sessions and their **per-session** UI state.
 *
 * The old store kept `remotePath` in one component's local state, so switching
 * tabs queried the newly active session at the previous session's path — and
 * selections leaked across servers. Path, selection and sort now live here,
 * keyed by session id, and are dropped with the session.
 */
import { create } from 'zustand';

import { call } from '../lib/ipc';
import type { ConnectArgs, ConnectResult, PaneSide, SessionMeta, SortState } from '../lib/types';
import { getSettings } from './settingsStore';

/** Everything the two panes need to remember about one session. */
export interface SessionUiState {
  remotePath: string;
  localPath: string;
  /** Absolute paths of the selected entries, per pane. */
  selection: Record<PaneSide, string[]>;
  sort: Record<PaneSide, SortState>;
  /** True when the connection was reported as encrypted. */
  secure: boolean;
}

const DEFAULT_SORT: SortState = { key: 'name', direction: 'asc' };

function initialUiState(secure: boolean, remotePath = '/', localPath = ''): SessionUiState {
  return {
    remotePath,
    localPath,
    selection: { local: [], remote: [] },
    sort: { local: { ...DEFAULT_SORT }, remote: { ...DEFAULT_SORT } },
    secure,
  };
}

interface SessionState {
  /** Session identity, keyed by id. */
  sessions: Record<string, SessionMeta>;
  /** Tab order — `sessions` is a map, so order lives separately. */
  order: string[];
  activeId: string | null;
  ui: Record<string, SessionUiState>;
  /** Ids currently being disconnected, so a tab cannot be closed twice. */
  closing: string[];

  // ── Reads ──
  active: () => SessionMeta | null;
  activeUi: () => SessionUiState | null;
  list: () => SessionMeta[];
  uiFor: (sessionId: string) => SessionUiState | null;

  // ── Session lifecycle ──
  /**
   * Open a session.
   *
   * Rejections are **surfaced to the caller unchanged**, so an
   * `untrusted_host` or `vault_locked` error reaches the dialog that knows what
   * to do with it. This function never guesses and never swallows.
   */
  connect: (args: ConnectArgs) => Promise<ConnectResult>;
  /** Open a session from a bookmark, same error contract as {@link connect}. */
  connectBookmark: (bookmarkId: string) => Promise<ConnectResult>;
  /**
   * Close a session. The tab is removed **first**, then the backend is told, so
   * a dead socket or a slow server can never leave a stuck tab. Backend errors
   * are swallowed on purpose: from the user's point of view the tab is gone.
   */
  disconnect: (sessionId: string) => Promise<void>;
  /** Reconcile with `list_sessions`, e.g. after a reload. */
  hydrate: () => Promise<void>;
  setActive: (sessionId: string) => void;

  // ── Per-session UI state ──
  setRemotePath: (sessionId: string, path: string) => void;
  setLocalPath: (sessionId: string, path: string) => void;
  setSelection: (sessionId: string, side: PaneSide, paths: string[]) => void;
  clearSelection: (sessionId: string, side: PaneSide) => void;
  setSort: (sessionId: string, side: PaneSide, sort: SortState) => void;
}

/** Reducer helper: drop a session from every collection at once. */
function withoutSession(state: SessionState, sessionId: string) {
  const sessions = { ...state.sessions };
  const ui = { ...state.ui };
  delete sessions[sessionId];
  delete ui[sessionId];

  const order = state.order.filter((id) => id !== sessionId);
  const activeId =
    state.activeId === sessionId ? (order[order.length - 1] ?? null) : state.activeId;

  return { sessions, ui, order, activeId };
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: {},
  order: [],
  activeId: null,
  ui: {},
  closing: [],

  active() {
    const { activeId, sessions } = get();
    return activeId ? (sessions[activeId] ?? null) : null;
  },

  activeUi() {
    const { activeId, ui } = get();
    return activeId ? (ui[activeId] ?? null) : null;
  },

  list() {
    const { order, sessions } = get();
    return order.map((id) => sessions[id]).filter((meta): meta is SessionMeta => Boolean(meta));
  },

  uiFor(sessionId) {
    return get().ui[sessionId] ?? null;
  },

  async connect(args) {
    const settings = getSettings();
    const result = await call<ConnectResult>('connect', {
      args: {
        ...args,
        connectTimeoutSecs: args.connectTimeoutSecs ?? settings.connectTimeoutSecs,
        ioTimeoutSecs: args.ioTimeoutSecs ?? settings.ioTimeoutSecs,
      },
    });
    get().setActive(adoptSession(set, get, result));
    return result;
  },

  async connectBookmark(bookmarkId) {
    const result = await call<ConnectResult>('connect_bookmark', { id: bookmarkId });
    get().setActive(adoptSession(set, get, result));
    return result;
  },

  async disconnect(sessionId) {
    // Remove the tab before awaiting anything. The backend treats
    // disconnecting an already-gone session as success, so there is nothing to
    // roll back if the call fails.
    set((state) => ({
      ...withoutSession(state, sessionId),
      closing: [...state.closing, sessionId],
    }));

    try {
      await call<void>('disconnect', { sessionId });
    } catch {
      // Already closed, or the socket was dead. The tab is gone either way;
      // re-adding it would be worse than a silently freed backend session.
    } finally {
      set((state) => ({ closing: state.closing.filter((id) => id !== sessionId) }));
    }
  },

  async hydrate() {
    const live = await call<SessionMeta[]>('list_sessions');
    set((state) => {
      const sessions: Record<string, SessionMeta> = {};
      const ui: Record<string, SessionUiState> = {};
      for (const meta of live) {
        sessions[meta.id] = meta;
        ui[meta.id] = state.ui[meta.id] ?? initialUiState(meta.protocol !== 'ftp');
      }
      const order = [
        ...state.order.filter((id) => sessions[id]),
        ...live.map((m) => m.id).filter((id) => !state.order.includes(id)),
      ];
      const activeId =
        state.activeId && sessions[state.activeId] ? state.activeId : (order[0] ?? null);
      return { sessions, ui, order, activeId };
    });
  },

  setActive(sessionId) {
    if (!get().sessions[sessionId]) return;
    set({ activeId: sessionId });
  },

  setRemotePath(sessionId, path) {
    patchUi(set, sessionId, (ui) => ({
      ...ui,
      remotePath: path,
      // Navigation always clears the selection; a stale path selection is how
      // the old UI managed to delete the wrong files.
      selection: { ...ui.selection, remote: [] },
    }));
  },

  setLocalPath(sessionId, path) {
    patchUi(set, sessionId, (ui) => ({
      ...ui,
      localPath: path,
      selection: { ...ui.selection, local: [] },
    }));
  },

  setSelection(sessionId, side, paths) {
    patchUi(set, sessionId, (ui) => ({
      ...ui,
      selection: { ...ui.selection, [side]: paths },
    }));
  },

  clearSelection(sessionId, side) {
    patchUi(set, sessionId, (ui) => ({
      ...ui,
      selection: { ...ui.selection, [side]: [] },
    }));
  },

  setSort(sessionId, side, sort) {
    patchUi(set, sessionId, (ui) => ({
      ...ui,
      sort: { ...ui.sort, [side]: sort },
    }));
  },
}));

type SetState = (
  partial: Partial<SessionState> | ((state: SessionState) => Partial<SessionState>),
) => void;

/** Insert a freshly opened session and return its id. */
function adoptSession(set: SetState, get: () => SessionState, result: ConnectResult): string {
  const meta = result.session;
  const previous = get().ui[meta.id];

  set((state) => ({
    sessions: { ...state.sessions, [meta.id]: meta },
    order: state.order.includes(meta.id) ? state.order : [...state.order, meta.id],
    ui: {
      ...state.ui,
      // Reconnecting the same id keeps where the user was.
      [meta.id]: previous ? { ...previous, secure: result.secure } : initialUiState(result.secure),
    },
  }));

  return meta.id;
}

function patchUi(
  set: SetState,
  sessionId: string,
  update: (ui: SessionUiState) => SessionUiState,
): void {
  set((state) => {
    const current = state.ui[sessionId];
    if (!current) return {};
    return { ui: { ...state.ui, [sessionId]: update(current) } };
  });
}
