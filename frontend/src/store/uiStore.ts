/**
 * Which dialog is open, its payload, and panel visibility.
 *
 * Dialogs are modelled as a single discriminated union rather than a pile of
 * booleans, so two modals can never be open at once and every dialog's payload
 * is type-checked at the call site.
 */
import { create } from 'zustand';

import type {
  AppError,
  Bookmark,
  ConflictPolicy,
  DiffResult,
  EnqueueItem,
  OpenedFile,
  PaneSide,
  RemoteFile,
  TrustKind,
} from '../lib/types';

/** One destination collision the user has to resolve before enqueueing. */
export interface ConflictEntry {
  /** The item as it would be enqueued, minus the resolved policy. */
  item: Omit<EnqueueItem, 'onConflict'>;
  /** Size of the file already at the destination, when known. */
  existingSize: number | null;
  existingModified: string | null;
  incomingSize: number | null;
  incomingModified: string | null;
}

export type DialogState =
  | { kind: 'none' }
  /** Host identity needs verifying. Opened from an `untrusted_host` rejection. */
  | {
      kind: 'trust';
      host: string;
      port: number;
      trustKind: TrustKind;
      algorithm: string;
      fingerprint: string;
      /** Present means the fingerprint CHANGED — style this as danger. */
      previousFingerprint: string | null;
      /** English backend detail. */
      message: string;
      /** Retried after `trust_host` succeeds. */
      onTrusted?: () => void;
    }
  /** Vault initialize or unlock. Opened from a `vault_locked` rejection. */
  | { kind: 'vault'; mode: 'initialize' | 'unlock' | 'change'; onUnlocked?: () => void }
  /** Destination collisions, resolved before `enqueue_transfers`. */
  | {
      kind: 'conflict';
      sessionId: string;
      entries: ConflictEntry[];
      onResolved: (resolved: { item: ConflictEntry['item']; policy: ConflictPolicy }[]) => void;
    }
  /** A save was refused because the remote file changed. */
  | {
      kind: 'saveConflict';
      tabId: string;
      /** Hash the server currently reports, from the `conflict` error. */
      remoteHash: string | null;
      diff: DiffResult | null;
      /** Server content, fetched lazily when the user asks for a diff. */
      remote: OpenedFile | null;
    }
  | { kind: 'settings'; tab?: 'general' | 'transfers' | 'editor' | 'security' | 'ai' }
  /** New connection. `bookmark` prefills the form for an edit. */
  | { kind: 'connection'; bookmark?: Bookmark | null; editing?: boolean }
  | { kind: 'scripts'; scriptId?: string | null }
  | { kind: 'chmod'; sessionId: string; targets: RemoteFile[] }
  | { kind: 'newFolder'; sessionId: string; side: PaneSide; parentPath: string }
  | {
      kind: 'rename';
      sessionId: string;
      side: PaneSide;
      path: string;
      currentName: string;
    }
  | { kind: 'shortcuts' }
  | { kind: 'bookmarkExport' }
  | { kind: 'bookmarkImport' };

export type PanelName = 'sidebar' | 'transfers' | 'editor' | 'git' | 'ai';

interface UiState {
  dialog: DialogState;
  /** Which panels are shown. */
  panels: Record<PanelName, boolean>;
  /** Transfer queue collapsed to its one-line summary. */
  transfersCollapsed: boolean;
  /** Remembered transfer-queue height in px. */
  transfersHeight: number;
  /** Local/remote split ratio in `[0.2, 0.8]`. */
  splitRatio: number;
  /** Which pane has keyboard focus, for global shortcuts. */
  focusedPane: PaneSide;

  openDialog: (dialog: DialogState) => void;
  closeDialog: () => void;
  /** Convenience: open the right dialog for a `untrusted_host`/`vault_locked` error. */
  openDialogForError: (error: AppError, retry?: () => void) => boolean;

  togglePanel: (panel: PanelName) => void;
  setPanel: (panel: PanelName, visible: boolean) => void;
  setTransfersCollapsed: (collapsed: boolean) => void;
  setTransfersHeight: (height: number) => void;
  setSplitRatio: (ratio: number) => void;
  setFocusedPane: (pane: PaneSide) => void;
}

export const useUiStore = create<UiState>((set) => ({
  dialog: { kind: 'none' },
  panels: { sidebar: true, transfers: true, editor: false, git: false, ai: false },
  transfersCollapsed: false,
  transfersHeight: 180,
  splitRatio: 0.5,
  focusedPane: 'local',

  openDialog(dialog) {
    set({ dialog });
  },

  closeDialog() {
    set({ dialog: { kind: 'none' } });
  },

  openDialogForError(error, retry) {
    if (error.code === 'untrusted_host') {
      set({
        dialog: {
          kind: 'trust',
          host: error.host,
          port: error.port,
          trustKind: error.kind,
          algorithm: error.algorithm,
          fingerprint: error.fingerprint,
          previousFingerprint: error.previousFingerprint,
          message: error.message,
          onTrusted: retry,
        },
      });
      return true;
    }
    if (error.code === 'vault_locked') {
      set({ dialog: { kind: 'vault', mode: 'unlock', onUnlocked: retry } });
      return true;
    }
    return false;
  },

  togglePanel(panel) {
    set((state) => ({ panels: { ...state.panels, [panel]: !state.panels[panel] } }));
  },

  setPanel(panel, visible) {
    set((state) => ({ panels: { ...state.panels, [panel]: visible } }));
  },

  setTransfersCollapsed(collapsed) {
    set({ transfersCollapsed: collapsed });
  },

  setTransfersHeight(height) {
    set({ transfersHeight: Math.max(64, Math.min(600, Math.round(height))) });
  },

  setSplitRatio(ratio) {
    set({ splitRatio: Math.max(0.2, Math.min(0.8, ratio)) });
  },

  setFocusedPane(pane) {
    set({ focusedPane: pane });
  },
}));
