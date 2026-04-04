import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Settings {
  // General
  defaultProtocol: string;
  defaultPort: number;
  connectTimeout: number; // seconds
  // Transfer
  transferMode: "passive" | "active";
  maxConcurrentTransfers: number;
  overwriteMode: "ask" | "overwrite" | "skip" | "rename";
  // UI
  theme: "dark" | "light" | "system";
  showHiddenFiles: boolean;
  dateFormat: "relative" | "absolute";
  doubleClickAction: "open" | "transfer";
}

interface SettingsState {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const DEFAULTS: Settings = {
  defaultProtocol: "ftp",
  defaultPort: 21,
  connectTimeout: 20,
  transferMode: "passive",
  maxConcurrentTransfers: 3,
  overwriteMode: "ask",
  theme: "dark",
  showHiddenFiles: false,
  dateFormat: "relative",
  doubleClickAction: "open",
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      settings: { ...DEFAULTS },
      update(patch) {
        set((s) => ({ settings: { ...s.settings, ...patch } }));
      },
      reset() {
        set({ settings: { ...DEFAULTS } });
      },
    }),
    { name: "ftpie-settings" }
  )
);
