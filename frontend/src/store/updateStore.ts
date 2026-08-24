/**
 * Auto-update state.
 *
 * The invariant this store exists to protect: **checking is automatic,
 * installing is not.** `check()` is safe to call on startup; `install()` only
 * ever runs from a click. Nothing here installs on a timer, on a retry, or as a
 * side effect of a successful check.
 *
 * Download progress arrives as backend `update:progress` events rather than as
 * a resolved promise, because `update_install` does not return — the app is
 * relaunched out from under it once the artifact is verified and staged.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { call } from '../lib/ipc';

/** A release newer than the running build. Mirrors the Rust `UpdateInfo`. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** Plain text off the network — render as text, never as markup. */
  notes: string | null;
  pubDate: string | null;
}

/** Payload of `update:progress`. `total` is null when the server sent no length. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

interface UpdateState {
  /** The offered update, or null when up to date / not yet checked. */
  available: UpdateInfo | null;
  checking: boolean;
  /** True from the click until the relaunch (or until it fails). */
  installing: boolean;
  /** Latest progress tick, or null before the first byte arrives. */
  progress: UpdateProgress | null;
  /** True once the user chose "Later" — suppresses the banner this run only. */
  dismissed: boolean;
  /** True after one completed check, so a remount does not re-query. */
  checked: boolean;
  error: unknown;

  /** Download fraction in `[0, 1]`, or null when the total is unknown. */
  ratio: () => number | null;
  /** Whether the banner should be on screen right now. */
  shouldShow: () => boolean;

  /**
   * Attach the `update:progress` listener. Idempotent; the returned function
   * detaches it.
   */
  subscribe: () => Promise<UnlistenFn>;

  /** Ask the endpoint for a newer signed release. `null` means up to date. */
  check: () => Promise<UpdateInfo | null>;
  /** Download, verify, install and relaunch. Explicit user action only. */
  install: () => Promise<void>;
  /** Hide the banner for this run. Does not remember across restarts. */
  dismiss: () => void;
  clearError: () => void;
}

let unlistenHandle: UnlistenFn | null = null;
let subscribing: Promise<UnlistenFn> | null = null;
/** In-flight check, so a double mount issues one request. */
let checking: Promise<UpdateInfo | null> | null = null;

export const useUpdateStore = create<UpdateState>((set, get) => ({
  available: null,
  checking: false,
  installing: false,
  progress: null,
  dismissed: false,
  checked: false,
  error: null,

  ratio() {
    const progress = get().progress;
    if (!progress || progress.total === null || progress.total <= 0) return null;
    return Math.max(0, Math.min(1, progress.downloaded / progress.total));
  },

  shouldShow() {
    const { available, dismissed } = get();
    return Boolean(available) && !dismissed;
  },

  async subscribe() {
    if (unlistenHandle) {
      const handle = unlistenHandle;
      return () => detach(handle);
    }
    if (subscribing) return subscribing;

    subscribing = (async () => {
      const handle = await listen<UpdateProgress>('update:progress', (event) => {
        set({ progress: event.payload });
      });
      unlistenHandle = handle;
      subscribing = null;
      return () => detach(handle);
    })();

    try {
      return await subscribing;
    } catch (error) {
      subscribing = null;
      throw error;
    }
  },

  async check() {
    if (checking) return checking;

    set({ checking: true, error: null });
    checking = (async () => {
      try {
        const info = await call<UpdateInfo | null>('update_check');
        // A newly offered version un-dismisses the banner: "Later" was an
        // answer about one release, not a standing preference.
        set((state) => ({
          available: info ?? null,
          checking: false,
          checked: true,
          error: null,
          dismissed: info && info.version !== state.available?.version ? false : state.dismissed,
        }));
        return info ?? null;
      } catch (error) {
        // A failed check is deliberately quiet: it is background work the user
        // did not ask for, so it records the error and shows no banner.
        set({ checking: false, checked: true, error });
        return null;
      } finally {
        checking = null;
      }
    })();

    return checking;
  },

  async install() {
    if (get().installing) return;
    set({ installing: true, error: null, progress: { downloaded: 0, total: null } });
    try {
      // Resolves only if the relaunch did not happen — on success the process
      // is replaced and this line is never reached.
      await call<void>('update_install');
    } catch (error) {
      set({ installing: false, progress: null, error });
      throw error;
    }
  },

  dismiss() {
    set({ dismissed: true });
  },

  clearError() {
    set({ error: null });
  },
}));

function detach(handle: UnlistenFn): void {
  try {
    handle();
  } catch {
    // Already gone — the window is closing.
  }
  if (unlistenHandle === handle) unlistenHandle = null;
}

/** Test-only: forget the module-level listener and in-flight check. */
export function resetUpdateSubscription(): void {
  unlistenHandle = null;
  subscribing = null;
  checking = null;
}
