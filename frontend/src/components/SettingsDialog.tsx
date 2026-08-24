/* eslint-disable react-refresh/only-export-components */
/**
 * SettingsDialog — only settings that something actually honours.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <SettingsDialog
 *   open={dialog.kind === 'settings'}
 *   onOpenChange={(open) => (open ? undefined : closeDialog())}
 *   initialTab={dialog.kind === 'settings' ? dialog.tab : undefined}
 * />
 * ```
 *
 * ## What honours what
 * Six of the old ten settings did nothing. Every control below is annotated with
 * its consumer, cross-checked against `settingsStore`'s field docs and the
 * backend command list:
 *
 * | Setting | Honoured by |
 * | --- | --- |
 * | `locale` | `I18nProvider` (every `t()` call) |
 * | `theme` | `App.tsx` (`data-theme` + the `dark` class, `matchMedia` listener) |
 * | `dateFormat` | `format.formatDate` — file lists, deploy history, scripts |
 * | `defaultProtocol` | `ConnectionDialog`'s initial protocol |
 * | `showHiddenFiles` | both `FilePane`s (local as well as remote) |
 * | `confirmDelete` | the delete flows' `AlertDialog` |
 * | `maxConcurrentTransfers` | pushed to the backend, `set_max_concurrent_transfers` |
 * | `overwriteMode` | `FilePane` resolves it before `enqueue_transfers` |
 * | `doubleClickAction` | `FilePane`'s Enter / double-click branch |
 * | `connectTimeoutSecs` / `ioTimeoutSecs` | passed into `connect` |
 * | `editorFontSize` / `editorTabSize` / `editorWordWrap` | `EditorPane`, `ScriptManager` |
 *
 * Nothing else is offered. `transferMode` is gone because it was never wired to
 * anything; passive mode is a per-connection choice and lives on the connection
 * form.
 *
 * The Security tab talks to `vault_lock` / `vault_change_password` /
 * `list_trusted_hosts` / `forget_trusted_host`; the AI tab to `ai_list_providers`
 * / `ai_set_key` / `ai_clear_key`. None of those are settings-store fields — they
 * are backend state, shown here because this is where people look for them.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { chunkFingerprint, formatDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import {
  AI_PROVIDERS,
  PROTOCOLS,
  type AiProvider,
  type AiProviderInfo,
  type AppInfo,
  type DateFormat,
  type DoubleClickAction,
  type Locale,
  type OverwriteMode,
  type Protocol,
  type ThemePreference,
  type TrustEntry,
} from '../lib/types';
import { DEFAULT_SETTINGS, useSettingsStore } from '../store/settingsStore';
import { useVaultStore } from '../store/vaultStore';
import {
  AlertDialog,
  Button,
  Dialog,
  ErrorState,
  Field,
  Icon,
  Input,
  InlineError,
  NumberInput,
  Select,
  Separator,
  Switch,
  Tabs,
  useToast,
} from './ui';

// ── Validation (pure, tested) ───────────────────────────────────────────────

/** Minimum master-password length the UI enforces before calling the vault. */
export const MIN_MASTER_PASSWORD = 8;

export type BaseUrlVerdict = 'ok' | 'empty' | 'invalid';

/**
 * Mirror of the backend's `validate_custom_base_url`: `https` anywhere, or
 * `http` only for `localhost` / `127.0.0.1` / `[::1]`. Embedded credentials and
 * any other scheme are rejected.
 *
 * The backend is still the authority — this only spares the user a round trip
 * and gives the field an inline message.
 */
export function validateBaseUrl(raw: string): BaseUrlVerdict {
  const trimmed = raw.trim();
  if (trimmed === '') return 'empty';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'invalid';
  }
  if (url.username !== '' || url.password !== '') return 'invalid';
  if (url.protocol === 'https:') return 'ok';
  if (url.protocol !== 'http:') return 'invalid';

  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'];
  return loopback.includes(url.hostname) ? 'ok' : 'invalid';
}

export type PasswordChangeVerdict = 'ok' | 'missingCurrent' | 'tooShort' | 'mismatch';

/** Local checks before `vault_change_password`; the vault verifies the old one. */
export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
  minLength = MIN_MASTER_PASSWORD,
): PasswordChangeVerdict {
  if (current === '') return 'missingCurrent';
  if (next.length < minLength) return 'tooShort';
  if (next !== confirm) return 'mismatch';
  return 'ok';
}

// ── Component ───────────────────────────────────────────────────────────────

export type SettingsTab = 'general' | 'transfers' | 'editor' | 'security' | 'ai';

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: SettingsTab;
}

export function SettingsDialog({ open, onOpenChange, initialTab }: SettingsDialogProps) {
  const { t, setLocale } = useT();
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'general');
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [initialTab, open]);

  const settings = useSettingsStore();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!open) return;
    void call<AppInfo>('app_version')
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t('settings.title')}
      description={t('settings.appliedImmediately')}
      className="h-[80vh]"
      footer={
        <div className="flex w-full items-center gap-2">
          {info ? (
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-3">
              {t('app.version', { version: info.version })} · {t('settings.configDir')}:{' '}
              {info.configDir}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <Button variant="danger" className="press" onClick={() => setConfirmReset(true)}>
            {t('common.resetDefaults')}
          </Button>
          <Button variant="primary" className="press" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <Tabs
        label={t('settings.title')}
        value={tab}
        onValueChange={setTab}
        tabs={[
          { id: 'general', label: t('settings.tab.general') },
          { id: 'transfers', label: t('settings.tab.transfers') },
          { id: 'editor', label: t('settings.tab.editor') },
          { id: 'security', label: t('settings.tab.security') },
          { id: 'ai', label: t('settings.tab.ai') },
        ]}
        className="min-h-0 flex-1"
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-1">
          {tab === 'general' ? (
            <>
              <SettingsGroup label={t('settings.group.appearance')}>
                <Field label={t('settings.locale')} hint={t('settings.localeHint')}>
                  {({ id }) => (
                    <Select
                      id={id}
                      value={settings.locale}
                      onValueChange={(value) => {
                        const next = value as Locale;
                        settings.set({ locale: next });
                        // The provider is what every t() reads; keep them in step.
                        setLocale(next);
                      }}
                      options={[
                        { value: 'tr', label: t('settings.locale.tr') },
                        { value: 'en', label: t('settings.locale.en') },
                      ]}
                    />
                  )}
                </Field>

                <Field label={t('settings.theme')} hint={t('settings.themeHint')}>
                  {({ id }) => (
                    <Select
                      id={id}
                      value={settings.theme}
                      onValueChange={(value) => settings.set({ theme: value as ThemePreference })}
                      options={[
                        { value: 'system', label: t('settings.theme.system') },
                        { value: 'light', label: t('settings.theme.light') },
                        { value: 'dark', label: t('settings.theme.dark') },
                      ]}
                    />
                  )}
                </Field>

                <Field label={t('settings.dateFormat')} hint={t('settings.dateFormatHint')}>
                  {({ id }) => (
                    <Select
                      id={id}
                      value={settings.dateFormat}
                      onValueChange={(value) => settings.set({ dateFormat: value as DateFormat })}
                      options={[
                        { value: 'relative', label: t('settings.dateFormat.relative') },
                        { value: 'short', label: t('settings.dateFormat.short') },
                        { value: 'iso', label: t('settings.dateFormat.iso') },
                      ]}
                    />
                  )}
                </Field>
              </SettingsGroup>

              <SettingsGroup label={t('settings.group.behaviour')}>
                <Field
                  label={t('settings.defaultProtocol')}
                  hint={t('settings.defaultProtocolHint')}
                >
                  {({ id }) => (
                    <Select
                      id={id}
                      value={settings.defaultProtocol}
                      onValueChange={(value) =>
                        settings.set({ defaultProtocol: value as Protocol })
                      }
                      options={PROTOCOLS.map((protocol) => ({
                        value: protocol,
                        label: t(`conn.protocol.${protocol}`),
                      }))}
                    />
                  )}
                </Field>

                <Switch
                  checked={settings.showHiddenFiles}
                  onCheckedChange={(checked) => settings.set({ showHiddenFiles: checked })}
                  label={t('settings.showHiddenFiles')}
                  hint={t('settings.showHiddenFilesHint')}
                />
                <Switch
                  checked={settings.confirmDelete}
                  onCheckedChange={(checked) => settings.set({ confirmDelete: checked })}
                  label={t('settings.confirmDelete')}
                  hint={t('settings.confirmDeleteHint')}
                />
              </SettingsGroup>
            </>
          ) : null}

          {tab === 'transfers' ? (
            <>
              <SettingsGroup label={t('settings.group.queue')}>
                <Field
                  label={t('settings.maxConcurrentTransfers')}
                  hint={t('transfer.concurrencySessionsNote')}
                >
                  {({ id, describedBy }) => (
                    <NumberInput
                      id={id}
                      aria-describedby={describedBy}
                      value={settings.maxConcurrentTransfers}
                      onValueChange={(value) =>
                        settings.set({
                          maxConcurrentTransfers: value ?? DEFAULT_SETTINGS.maxConcurrentTransfers,
                        })
                      }
                      min={1}
                      max={16}
                      className="w-20"
                    />
                  )}
                </Field>
              </SettingsGroup>

              <SettingsGroup label={t('settings.group.conflicts')}>
                <Field label={t('settings.overwriteMode')} hint={t('settings.overwriteModeHint')}>
                  {({ id }) => (
                    <Select
                      id={id}
                      value={settings.overwriteMode}
                      onValueChange={(value) =>
                        settings.set({ overwriteMode: value as OverwriteMode })
                      }
                      options={[
                        { value: 'ask', label: t('settings.overwriteMode.ask') },
                        { value: 'overwrite', label: t('settings.overwriteMode.overwrite') },
                        { value: 'skip', label: t('settings.overwriteMode.skip') },
                        { value: 'rename', label: t('settings.overwriteMode.rename') },
                      ]}
                    />
                  )}
                </Field>

                <Field
                  label={t('settings.doubleClickAction')}
                  hint={t('settings.doubleClickActionHint')}
                >
                  {({ id }) => (
                    <Select
                      id={id}
                      value={settings.doubleClickAction}
                      onValueChange={(value) =>
                        settings.set({ doubleClickAction: value as DoubleClickAction })
                      }
                      options={[
                        { value: 'open', label: t('settings.doubleClickAction.open') },
                        { value: 'download', label: t('settings.doubleClickAction.download') },
                      ]}
                    />
                  )}
                </Field>
              </SettingsGroup>

              <SettingsGroup label={t('settings.group.timeouts')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('settings.connectTimeout')} hint={t('settings.seconds')}>
                    {({ id, describedBy }) => (
                      <NumberInput
                        id={id}
                        aria-describedby={describedBy}
                        value={settings.connectTimeoutSecs}
                        onValueChange={(value) =>
                          settings.set({
                            connectTimeoutSecs: value ?? DEFAULT_SETTINGS.connectTimeoutSecs,
                          })
                        }
                        min={1}
                        max={300}
                      />
                    )}
                  </Field>
                  <Field label={t('settings.ioTimeout')} hint={t('settings.seconds')}>
                    {({ id, describedBy }) => (
                      <NumberInput
                        id={id}
                        aria-describedby={describedBy}
                        value={settings.ioTimeoutSecs}
                        onValueChange={(value) =>
                          settings.set({ ioTimeoutSecs: value ?? DEFAULT_SETTINGS.ioTimeoutSecs })
                        }
                        min={1}
                        max={3600}
                      />
                    )}
                  </Field>
                </div>
              </SettingsGroup>
            </>
          ) : null}

          {tab === 'editor' ? (
            <>
              <SettingsGroup label={t('settings.group.editorText')}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t('settings.editorFontSize')}>
                    {({ id }) => (
                      <NumberInput
                        id={id}
                        value={settings.editorFontSize}
                        onValueChange={(value) =>
                          settings.set({
                            editorFontSize: value ?? DEFAULT_SETTINGS.editorFontSize,
                          })
                        }
                        min={9}
                        max={32}
                      />
                    )}
                  </Field>
                  <Field label={t('settings.editorTabSize')}>
                    {({ id }) => (
                      <NumberInput
                        id={id}
                        value={settings.editorTabSize}
                        onValueChange={(value) =>
                          settings.set({ editorTabSize: value ?? DEFAULT_SETTINGS.editorTabSize })
                        }
                        min={1}
                        max={8}
                      />
                    )}
                  </Field>
                </div>
              </SettingsGroup>

              <SettingsGroup label={t('settings.group.editorLayout')}>
                <Switch
                  checked={settings.editorWordWrap}
                  onCheckedChange={(checked) => settings.set({ editorWordWrap: checked })}
                  label={t('settings.editorWordWrap')}
                  hint={t('settings.editorWordWrapHint')}
                />
              </SettingsGroup>
            </>
          ) : null}

          {tab === 'security' ? <SecurityTab /> : null}
          {tab === 'ai' ? <AiKeysTab /> : null}
        </div>
      </Tabs>

      <AlertDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('settings.resetTitle')}
        description={t('settings.resetBody')}
        confirmLabel={t('common.resetDefaults')}
        onConfirm={() => {
          settings.reset();
          setLocale(DEFAULT_SETTINGS.locale);
          setConfirmReset(false);
        }}
      />
    </Dialog>
  );
}

// ── Security tab ────────────────────────────────────────────────────────────

function SecurityTab() {
  const { t, locale } = useT();
  const { toast, showError } = useToast();
  const dateFormat = useSettingsStore((s) => s.dateFormat);

  const vaultStatus = useVaultStore((s) => s.status);
  const vaultBusy = useVaultStore((s) => s.busy);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [changeError, setChangeError] = useState<unknown>(null);

  const [hosts, setHosts] = useState<TrustEntry[] | null>(null);
  const [hostsError, setHostsError] = useState<unknown>(null);
  const [forgetting, setForgetting] = useState<TrustEntry | null>(null);

  const verdict = useMemo(
    () => validatePasswordChange(current, next, confirm),
    [confirm, current, next],
  );

  useEffect(() => {
    void useVaultStore
      .getState()
      .refresh()
      .catch(() => {});
  }, []);

  const loadHosts = useCallback(async () => {
    setHostsError(null);
    try {
      setHosts(await call<TrustEntry[]>('list_trusted_hosts'));
    } catch (error) {
      setHosts(null);
      setHostsError(error);
    }
  }, []);

  useEffect(() => {
    void loadHosts();
  }, [loadHosts]);

  const changePassword = useCallback(async () => {
    setChangeError(null);
    try {
      await useVaultStore.getState().changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast({ title: t('vault.changed'), variant: 'ok' });
    } catch (error) {
      setChangeError(error);
    }
  }, [current, next, t, toast]);

  const forget = useCallback(
    async (entry: TrustEntry) => {
      try {
        await call<void>('forget_trusted_host', {
          host: entry.host,
          port: entry.port,
          kind: entry.kind,
        });
        await loadHosts();
      } catch (error) {
        showError(error);
      } finally {
        setForgetting(null);
      }
    },
    [loadHosts, showError],
  );

  return (
    <>
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-text">{t('settings.vault')}</h3>
          <span
            className={
              vaultStatus?.unlocked
                ? 'flex-none rounded-sm bg-ok-weak px-1.5 py-px text-2xs uppercase tracking-wider text-ok'
                : 'flex-none rounded-sm bg-warn-weak px-1.5 py-px text-2xs uppercase tracking-wider text-warn'
            }
          >
            {!vaultStatus?.initialized
              ? t('vault.notInitialized')
              : vaultStatus.unlocked
                ? t('vault.unlocked')
                : t('vault.locked')}
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            className="press"
            icon={<Icon name="lock" />}
            disabled={!vaultStatus?.unlocked || vaultBusy}
            onClick={() => {
              void useVaultStore
                .getState()
                .lock()
                .then(() => toast({ title: t('vault.locked'), variant: 'info' }))
                .catch((error: unknown) => showError(error));
            }}
          >
            {t('vault.lock')}
          </Button>
        </div>

        {vaultStatus?.initialized ? (
          <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-sm text-text-2">{t('vault.changePasswordBody')}</p>
            <Field label={t('vault.oldPassword')}>
              {({ id }) => (
                <Input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('vault.newPassword')}
              error={
                next !== '' && verdict === 'tooShort'
                  ? t('vault.tooShort', { min: MIN_MASTER_PASSWORD })
                  : null
              }
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('vault.confirmPassword')}
              error={confirm !== '' && verdict === 'mismatch' ? t('vault.mismatch') : null}
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
              )}
            </Field>
            <p className="flex items-start gap-2 rounded border border-border bg-warn-weak px-2 py-1.5 text-xs text-text">
              <Icon name="alert-triangle" className="mt-px flex-none text-warn" />
              {t('vault.cannotRecover')}
            </p>
            {changeError ? <InlineError error={changeError} /> : null}
            <div className="flex justify-end">
              <Button
                variant="primary"
                className="press"
                loading={vaultBusy}
                disabled={verdict !== 'ok'}
                onClick={() => void changePassword()}
              >
                {t('vault.changePassword')}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold tracking-tight text-text">
            {t('settings.trustedHosts')}
          </h3>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="press"
            icon={<Icon name="refresh" />}
            onClick={() => void loadHosts()}
          >
            {t('common.refresh')}
          </Button>
        </div>

        {hostsError ? (
          <ErrorState
            error={hostsError}
            title={t('settings.trustedHostsFailed')}
            compact
            onRetry={() => void loadHosts()}
          />
        ) : hosts === null ? (
          <p className="text-sm text-text-3">{t('common.loading')}</p>
        ) : hosts.length === 0 ? (
          <p className="text-sm text-text-3">{t('trust.listEmpty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {hosts.map((entry) => (
              <li
                key={`${entry.kind}:${entry.host}:${entry.port}`}
                className="flex items-start gap-2 rounded border border-border bg-surface-2 p-2.5 transition-quick hover:border-border-strong"
              >
                <Icon name="shield" size={16} className="mt-0.5 flex-none text-text-3" />
                <div className="min-w-0 flex-1">
                  <p className="select-text font-mono text-base text-text">
                    {entry.host}:{entry.port}
                  </p>
                  <p className="text-xs text-text-3">
                    {entry.kind === 'ssh_host_key'
                      ? t('trust.kind.ssh_host_key')
                      : t('trust.kind.tls_certificate')}{' '}
                    · {entry.algorithm} · {t('trust.added')}{' '}
                    {formatDate(entry.addedAt, locale, dateFormat)}
                  </p>
                  {/* Fingerprints are monospace and chunked so they can be
                      compared by eye against what the admin gave you. */}
                  <p className="select-text break-all font-mono text-xs text-text-2">
                    {chunkFingerprint(entry.fingerprint)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  className="press"
                  icon={<Icon name="trash" />}
                  onClick={() => setForgetting(entry)}
                >
                  {t('trust.forget')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AlertDialog
        open={forgetting !== null}
        onOpenChange={(open) => {
          if (!open) setForgetting(null);
        }}
        title={t('trust.forgetTitle')}
        description={t('trust.forgetBody', { host: forgetting?.host ?? '' })}
        confirmLabel={t('trust.forget')}
        onConfirm={() => {
          if (forgetting) void forget(forgetting);
        }}
      />
    </>
  );
}

// ── AI keys tab ─────────────────────────────────────────────────────────────

function AiKeysTab() {
  const { t } = useT();
  const { toast, showError } = useToast();
  const vaultUnlocked = useVaultStore((s) => Boolean(s.status?.unlocked));

  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [drafts, setDrafts] = useState<Partial<Record<AiProvider, string>>>({});
  const [busy, setBusy] = useState<AiProvider | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProviders(await call<AiProviderInfo[]>('ai_list_providers'));
    } catch (e) {
      setProviders(null);
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setKey = useCallback(
    async (provider: AiProvider) => {
      const key = (drafts[provider] ?? '').trim();
      if (key === '') return;
      setBusy(provider);
      try {
        await call<void>('ai_set_key', { provider, key });
        // The key is never kept in component state past this point.
        setDrafts((current) => ({ ...current, [provider]: '' }));
        toast({ title: t('ai.keySaved'), variant: 'ok' });
        await load();
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [drafts, load, showError, t, toast],
  );

  const clearKey = useCallback(
    async (provider: AiProvider) => {
      setBusy(provider);
      try {
        await call<void>('ai_clear_key', { provider });
        toast({ title: t('ai.keyCleared'), variant: 'info' });
        await load();
      } catch (e) {
        showError(e);
      } finally {
        setBusy(null);
      }
    },
    [load, showError, t, toast],
  );

  if (error) {
    return (
      <ErrorState
        error={error}
        title={t('ai.providersFailed')}
        compact
        onRetry={() => void load()}
      />
    );
  }

  return (
    <>
      <h3 className="text-sm font-semibold tracking-tight text-text">
        {t('settings.aiProviders')}
      </h3>
      <p className="text-xs text-text-3">{t('ai.keyStorageNote')}</p>
      {!vaultUnlocked ? (
        <p
          role="note"
          className="flex items-start gap-2 rounded border border-warn bg-warn-weak px-2.5 py-1.5 text-sm text-text"
        >
          <Icon name="lock" className="mt-px flex-none text-warn" />
          {t('settings.aiNeedsVault')}
        </p>
      ) : null}

      {providers === null ? (
        <p className="text-sm text-text-3">{t('common.loading')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {AI_PROVIDERS.map((provider) => {
            const info = providers.find((entry) => entry.provider === provider);
            if (!info) return null;
            return (
              <li
                key={provider}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-base font-medium text-text">
                    {t(`ai.provider.${provider}`)}
                  </span>
                  <span
                    className={
                      info.hasKey
                        ? 'flex-none rounded-sm bg-ok-weak px-1.5 py-px text-2xs uppercase tracking-wider text-ok'
                        : info.requiresKey
                          ? 'flex-none rounded-sm bg-warn-weak px-1.5 py-px text-2xs uppercase tracking-wider text-warn'
                          : 'flex-none rounded-sm bg-surface-3 px-1.5 py-px text-2xs uppercase tracking-wider text-text-2'
                    }
                  >
                    {info.hasKey
                      ? t('ai.keyConfigured')
                      : info.acceptsKey
                        ? t('ai.keyNotConfigured')
                        : t('settings.aiProviderNoKey')}
                  </span>
                  <span className="flex-1 truncate font-mono text-xs text-text-3">
                    {info.defaultModel}
                  </span>
                </div>

                {info.acceptsKey ? (
                  <div className="flex items-end gap-2">
                    <Field label={t('settings.aiKey')} className="flex-1">
                      {({ id }) => (
                        <Input
                          id={id}
                          type="password"
                          autoComplete="off"
                          mono
                          placeholder={t('settings.aiKeyPlaceholder')}
                          value={drafts[provider] ?? ''}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [provider]: event.target.value,
                            }))
                          }
                        />
                      )}
                    </Field>
                    <Button
                      className="press"
                      loading={busy === provider}
                      disabled={(drafts[provider] ?? '').trim() === '' || !vaultUnlocked}
                      onClick={() => void setKey(provider)}
                    >
                      {t('ai.setKey')}
                    </Button>
                    <Button
                      variant="danger"
                      className="press"
                      loading={busy === provider}
                      disabled={!info.hasKey}
                      onClick={() => void clearKey(provider)}
                    >
                      {t('ai.clearKey')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-text-3">{t('settings.aiProviderNoKey')}</p>
                )}

                {info.needsBaseUrl ? (
                  <p className="text-xs text-text-3">{t('ai.baseUrlInvalid')}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ── Layout ──────────────────────────────────────────────────────────────────

/**
 * A titled group of related settings.
 *
 * The old dialog was a flat stack of controls per tab — technically complete and
 * impossible to scan. A micro-label with a fading rule, and the controls inset
 * under it, gives each tab a shape without nesting boxes inside boxes.
 */
function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className="flex-none text-2xs uppercase tracking-wider text-text-3">{label}</h3>
        <span className="rule-soft flex-1" />
      </div>
      <div className="flex flex-col gap-3 pl-0.5">{children}</div>
    </section>
  );
}
