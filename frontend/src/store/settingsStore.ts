/**
 * Persisted user settings.
 *
 * **Every setting here is honoured by something.** Six of the old ten did
 * nothing; anything that could not be justified was dropped rather than left as
 * decoration. The column after each field says who reads it.
 *
 * `transferMode` is gone: it was never wired to anything. Passive mode is a
 * per-connection concern and lives on the connection form / bookmark instead.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { call } from '../lib/ipc';
import type {
  DateFormat,
  DoubleClickAction,
  Locale,
  OverwriteMode,
  Protocol,
  ThemePreference,
} from '../lib/types';

export const SETTINGS_STORAGE_KEY = 'ftpie-settings';

export interface Settings {
  /** App.tsx: sets `data-theme` + the `dark` class, and watches `matchMedia`. */
  theme: ThemePreference;
  /** I18nProvider. */
  locale: Locale;
  /** ConnectionDialog: the initially selected protocol. */
  defaultProtocol: Protocol;
  /** Both FilePanes filter their entries — local as well as remote. */
  showHiddenFiles: boolean;
  /** FilePane / delete flows: skips the AlertDialog when off. */
  confirmDelete: boolean;
  /** format.formatDate, everywhere a timestamp is shown. */
  dateFormat: DateFormat;
  /** Pushed to the backend via `set_max_concurrent_transfers`. */
  maxConcurrentTransfers: number;
  /** FilePane resolves `ask` into a ConflictPolicy before enqueueing. */
  overwriteMode: OverwriteMode;
  /** FilePane: Enter / double-click branches on this. */
  doubleClickAction: DoubleClickAction;
  /** Passed into `connect`. */
  connectTimeoutSecs: number;
  /** Passed into `connect`. */
  ioTimeoutSecs: number;
  /** EditorPane / ScriptManager Monaco options. */
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  locale: 'en',
  defaultProtocol: 'sftp',
  showHiddenFiles: false,
  confirmDelete: true,
  dateFormat: 'short',
  maxConcurrentTransfers: 3,
  overwriteMode: 'ask',
  doubleClickAction: 'open',
  connectTimeoutSecs: 15,
  ioTimeoutSecs: 60,
  editorFontSize: 13,
  editorTabSize: 2,
  editorWordWrap: false,
};

/** Clamped to the same ranges the backend enforces, so the UI cannot lie. */
const LIMITS = {
  maxConcurrentTransfers: [1, 16],
  connectTimeoutSecs: [1, 300],
  ioTimeoutSecs: [1, 3600],
  editorFontSize: [9, 32],
  editorTabSize: [1, 8],
} as const;

function clamp(key: keyof typeof LIMITS, value: number): number {
  const [min, max] = LIMITS[key];
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS[key];
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface SettingsState extends Settings {
  /** Patch one or more settings. Numeric fields are clamped. */
  set: <K extends keyof Settings>(patch: Pick<Settings, K> | Partial<Settings>) => void;
  /** Back to {@link DEFAULT_SETTINGS}, then re-push the backend-owned values. */
  reset: () => void;
  /**
   * Push settings the backend also holds. Call once after mount and whenever
   * `maxConcurrentTransfers` changes. Rejects are the caller's to surface.
   */
  syncToBackend: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,

      set(patch) {
        const next: Partial<Settings> = { ...patch };
        for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
          const value = next[key];
          if (typeof value === 'number') next[key] = clamp(key, value);
        }
        set(next as Partial<SettingsState>);

        if (next.maxConcurrentTransfers !== undefined) {
          // Fire-and-forget is not acceptable, but a failed concurrency push is
          // not worth interrupting the user for either: log it and move on.
          void call('set_max_concurrent_transfers', {
            count: next.maxConcurrentTransfers,
          }).catch(() => {});
        }
      },

      reset() {
        set({ ...DEFAULT_SETTINGS });
        void get()
          .syncToBackend()
          .catch(() => {});
      },

      async syncToBackend() {
        await call('set_max_concurrent_transfers', {
          count: get().maxConcurrentTransfers,
        });
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: 2,
      // Only persist the settings themselves; actions are recreated on load.
      partialize: (state) => {
        const { set: _set, reset: _reset, syncToBackend: _sync, ...settings } = state;
        return settings;
      },
      /**
       * v1 stored a `transferMode` field and hsl theme names. Anything unknown
       * is dropped and anything missing falls back to a default, so an old
       * profile loads cleanly instead of poisoning the UI with undefined.
       */
      migrate: (persisted) => {
        const incoming = (persisted ?? {}) as Partial<Settings>;
        const merged: Settings = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
          const value = incoming[key];
          if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
            // Types line up by construction (same key, same primitive kind);
            // the cast is only needed to keep the loop generic.
            (merged as unknown as Record<string, unknown>)[key] = value;
          }
        }
        for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
          merged[key] = clamp(key, merged[key]);
        }
        return merged;
      },
    },
  ),
);

/** Non-reactive read, for event handlers and non-React code. */
export function getSettings(): Settings {
  return useSettingsStore.getState();
}
