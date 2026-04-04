import { useState } from "react";
import { useSettingsStore } from "../store/settingsStore";

type Tab = "general" | "transfer" | "ui";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const { settings, update, reset } = useSettingsStore();
  const [tab, setTab] = useState<Tab>("general");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-xl w-[520px] max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <span className="text-sm font-semibold">Settings</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border px-4">
          {(["general", "transfer", "ui"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-xs font-medium capitalize border-b-2 -mb-px transition-colors ${
                tab === t
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "general" ? "General" : t === "transfer" ? "Transfer" : "Interface"}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {tab === "general" && (
            <>
              <Field label="Default Protocol">
                <select
                  value={settings.defaultProtocol}
                  onChange={(e) => update({ defaultProtocol: e.target.value })}
                  className="input-sm"
                >
                  <option value="ftp">FTP</option>
                  <option value="ftps">FTPS (Explicit)</option>
                  <option value="ftps_implicit">FTPS (Implicit)</option>
                  <option value="sftp">SFTP</option>
                </select>
              </Field>
              <Field label="Default Port">
                <input
                  type="number"
                  value={settings.defaultPort}
                  onChange={(e) => update({ defaultPort: parseInt(e.target.value) || 21 })}
                  className="input-sm w-24"
                />
              </Field>
              <Field label="Connect Timeout (seconds)">
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={settings.connectTimeout}
                  onChange={(e) => update({ connectTimeout: parseInt(e.target.value) || 20 })}
                  className="input-sm w-24"
                />
              </Field>
            </>
          )}

          {tab === "transfer" && (
            <>
              <Field label="Transfer Mode">
                <select
                  value={settings.transferMode}
                  onChange={(e) => update({ transferMode: e.target.value as "passive" | "active" })}
                  className="input-sm"
                >
                  <option value="passive">Passive (recommended)</option>
                  <option value="active">Active</option>
                </select>
              </Field>
              <Field label="Max Concurrent Transfers">
                <select
                  value={settings.maxConcurrentTransfers}
                  onChange={(e) => update({ maxConcurrentTransfers: parseInt(e.target.value) })}
                  className="input-sm w-24"
                >
                  {[1, 2, 3, 5, 10].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </Field>
              <Field label="Overwrite Mode">
                <select
                  value={settings.overwriteMode}
                  onChange={(e) => update({ overwriteMode: e.target.value as "ask" | "overwrite" | "skip" | "rename" })}
                  className="input-sm"
                >
                  <option value="ask">Ask</option>
                  <option value="overwrite">Always Overwrite</option>
                  <option value="skip">Skip Existing</option>
                  <option value="rename">Auto Rename</option>
                </select>
              </Field>
            </>
          )}

          {tab === "ui" && (
            <>
              <Field label="Theme">
                <select
                  value={settings.theme}
                  onChange={(e) => update({ theme: e.target.value as "dark" | "light" | "system" })}
                  className="input-sm"
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                  <option value="system">System</option>
                </select>
              </Field>
              <Field label="Show Hidden Files">
                <input
                  type="checkbox"
                  checked={settings.showHiddenFiles}
                  onChange={(e) => update({ showHiddenFiles: e.target.checked })}
                  className="w-4 h-4 accent-primary"
                />
              </Field>
              <Field label="Date Format">
                <select
                  value={settings.dateFormat}
                  onChange={(e) => update({ dateFormat: e.target.value as "relative" | "absolute" })}
                  className="input-sm"
                >
                  <option value="relative">Relative (2 hours ago)</option>
                  <option value="absolute">Absolute (2024-01-15)</option>
                </select>
              </Field>
              <Field label="Double-click Action">
                <select
                  value={settings.doubleClickAction}
                  onChange={(e) => update({ doubleClickAction: e.target.value as "open" | "transfer" })}
                  className="input-sm"
                >
                  <option value="open">Open in Editor</option>
                  <option value="transfer">Transfer</option>
                </select>
              </Field>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <button
            onClick={reset}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Reset to defaults
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-muted-foreground shrink-0 w-48">{label}</label>
      <div className="flex-1 flex justify-end">{children}</div>
    </div>
  );
}
