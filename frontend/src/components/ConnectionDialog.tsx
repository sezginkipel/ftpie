/**
 * Open a connection.
 *
 * Replaces the cramped `ConnectionBar`, and fixes its two real bugs:
 *
 * - The port now follows the protocol. Picking SFTP used to leave port 21 in
 *   the field, so the connection failed with a confusing network error.
 * - The port is a real numeric field. The old code ran `parseInt` on free text
 *   and happily sent `NaN` to the backend.
 *
 * `untrusted_host` and `vault_locked` are handed to their dialogs, which retry
 * this submit once the user has resolved them.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useT } from '../lib/i18n';
import { isAppError } from '../lib/ipc';
import {
  PROTOCOLS,
  defaultPort,
  isSecureProtocol,
  type ConnectArgs,
  type Protocol,
} from '../lib/types';
import { canStorePassword, useBookmarkStore } from '../store/bookmarkStore';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Icon,
  InlineError,
  Input,
  NumberInput,
  Select,
  Switch,
  useToast,
} from './ui';

/** Opens the OS file picker, or resolves null when there is no Tauri host. */
async function pickKeyFile(title: string): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const chosen = await open({ multiple: false, directory: false, title });
    return typeof chosen === 'string' ? chosen : null;
  } catch {
    return null;
  }
}

export function ConnectionDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const openDialogForError = useUiStore((state) => state.openDialogForError);
  const { t } = useT();
  const { toast } = useToast();

  const connect = useSessionStore((state) => state.connect);
  const createBookmark = useBookmarkStore((state) => state.create);
  const vaultStatus = useVaultStore((state) => state.status);
  const defaultProtocol = useSettingsStore((state) => state.defaultProtocol);

  const prefill = dialog.kind === 'connection' ? dialog.bookmark : null;

  const [protocol, setProtocol] = useState<Protocol>(defaultProtocol);
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number | null>(defaultPort(defaultProtocol));
  const [portTouched, setPortTouched] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [privateKeyPath, setPrivateKeyPath] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [passiveMode, setPassiveMode] = useState(true);
  const [saveBookmark, setSaveBookmark] = useState(false);
  const [bookmarkName, setBookmarkName] = useState('');
  const [savePassword, setSavePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [submitted, setSubmitted] = useState(false);

  const open = dialog.kind === 'connection';

  // Reset (or prefill) every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const initialProtocol = prefill?.protocol ?? defaultProtocol;
    setProtocol(initialProtocol);
    setHost(prefill?.host ?? '');
    setPort(prefill?.port ?? defaultPort(initialProtocol));
    setPortTouched(prefill !== null && prefill !== undefined);
    setUsername(prefill?.username ?? '');
    setPassword('');
    setPrivateKeyPath(prefill?.privateKeyPath ?? '');
    setKeyPassphrase('');
    setPassiveMode(prefill?.passiveMode ?? true);
    setSaveBookmark(false);
    setBookmarkName(prefill?.name ?? '');
    setSavePassword(false);
    setError(null);
    setBusy(false);
    setSubmitted(false);
  }, [open, prefill, defaultProtocol]);

  // The port follows the protocol until the user overrides it by hand.
  useEffect(() => {
    if (!portTouched) setPort(defaultPort(protocol));
  }, [protocol, portTouched]);

  const protocolOptions = useMemo(
    () =>
      PROTOCOLS.map((value) => ({
        value,
        label: t(`conn.protocol.${value}`),
      })),
    [t],
  );

  const isSftp = protocol === 'sftp';
  const secure = isSecureProtocol(protocol);
  const vaultReady = canStorePassword(vaultStatus);

  const hostError = submitted && host.trim() === '' ? t('conn.hostRequired') : null;
  const portError = port === null || port < 1 || port > 65535 ? t('conn.portInvalid') : null;
  const nameError =
    saveBookmark && bookmarkName.trim() === '' ? t('conn.bookmarkNameRequired') : null;
  const valid = host.trim() !== '' && portError === null && nameError === null;

  if (dialog.kind !== 'connection') return null;

  const buildArgs = (): ConnectArgs => ({
    host: host.trim(),
    port,
    username: username.trim(),
    password: password === '' ? null : password,
    protocol,
    passiveMode: isSftp ? null : passiveMode,
    privateKeyPath: isSftp && privateKeyPath !== '' ? privateKeyPath : null,
    keyPassphrase: isSftp && keyPassphrase !== '' ? keyPassphrase : null,
  });

  const submit = async () => {
    setSubmitted(true);
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const result = await connect(buildArgs());
      toast({ title: t('conn.connected', { host: result.session.host }), variant: 'ok' });

      if (saveBookmark) {
        try {
          await createBookmark({
            name: bookmarkName.trim(),
            host: host.trim(),
            port,
            username: username.trim(),
            password: savePassword && vaultReady && password !== '' ? password : null,
            protocol,
            privateKeyPath: isSftp && privateKeyPath !== '' ? privateKeyPath : null,
            passiveMode: isSftp ? null : passiveMode,
            tags: [],
          });
          toast({ title: t('bookmark.saved'), variant: 'ok' });
        } catch (bookmarkError) {
          // The connection succeeded; a failed bookmark must not read as a
          // failed connect.
          if (isAppError(bookmarkError) && bookmarkError.code === 'vault_locked') {
            toast({ title: t('vault.requiredToSave'), variant: 'warn' });
          } else {
            setError(bookmarkError);
            setBusy(false);
            return;
          }
        }
      }

      closeDialog();
    } catch (caught) {
      // Trust and vault prompts retry this same submit once resolved.
      if (isAppError(caught) && openDialogForError(caught, () => void submit())) {
        setBusy(false);
        return;
      }
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={t('conn.title')}
      size="md"
      footer={
        <>
          <InlineError error={error} className="mr-auto" />
          <Button variant="secondary" className="press" onClick={closeDialog} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            className="press"
            loading={busy}
            onClick={() => void submit()}
            icon={<Icon name={secure ? 'lock' : 'unlock'} />}
          >
            {busy ? t('conn.connecting') : t('common.connect')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormSection label={t('conn.sectionServer')}>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label={t('conn.protocol')}>
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={protocol}
                  onValueChange={setProtocol}
                  options={protocolOptions}
                />
              )}
            </Field>
            <Field
              label={t('conn.port')}
              hint={t('conn.portRange')}
              error={submitted ? portError : null}
              required
            >
              {({ id, describedBy, invalid }) => (
                <NumberInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={port}
                  onValueChange={(value) => {
                    setPortTouched(true);
                    setPort(value);
                  }}
                  min={1}
                  max={65535}
                  className="w-24"
                />
              )}
            </Field>
          </div>

          {/*
           * Plaintext FTP sends the password in the clear. That is a real warning,
           * so it gets a real banner — a tinted band with an icon and a heading,
           * not a line of grey text nobody reads.
           */}
          {!secure ? (
            <div
              role="note"
              className="flex items-start gap-2.5 rounded border border-warn bg-warn-weak p-2.5"
            >
              <Icon name="alert-triangle" size={16} className="mt-px flex-none text-warn" />
              <div className="min-w-0">
                <p className="text-base font-semibold tracking-tight text-text">
                  {t('conn.plaintextWarningTitle')}
                </p>
                <p className="mt-0.5 text-sm text-text-2">{t('conn.plaintextWarningBody')}</p>
              </div>
            </div>
          ) : null}

          <Field label={t('conn.host')} hint={t('conn.hostHint')} error={hostError} required>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                autoFocus
                mono
                placeholder={t('conn.hostPlaceholder')}
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
            )}
          </Field>
        </FormSection>

        <FormSection label={t('conn.sectionCredentials')}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('conn.username')}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="off"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('conn.password')}>
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
          </div>

          {isSftp ? (
            <>
              <Field label={t('conn.privateKey')} hint={t('common.optional')}>
                {({ id, describedBy }) => (
                  <div className="flex gap-2">
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      mono
                      value={privateKeyPath}
                      onChange={(event) => setPrivateKeyPath(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        void pickKeyFile(t('conn.privateKeyPick')).then((chosen) => {
                          if (chosen) setPrivateKeyPath(chosen);
                        });
                      }}
                    >
                      {t('common.browse')}
                    </Button>
                  </div>
                )}
              </Field>
              {privateKeyPath !== '' ? (
                <Field label={t('conn.keyPassphrase')} hint={t('common.optional')}>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      type="password"
                      autoComplete="off"
                      value={keyPassphrase}
                      onChange={(event) => setKeyPassphrase(event.target.value)}
                    />
                  )}
                </Field>
              ) : null}
            </>
          ) : (
            <Switch
              checked={passiveMode}
              onCheckedChange={setPassiveMode}
              label={t('conn.passiveMode')}
              hint={t('conn.passiveModeHint')}
            />
          )}
        </FormSection>

        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-2 p-2.5">
          <Checkbox
            checked={saveBookmark}
            onCheckedChange={setSaveBookmark}
            label={t('conn.saveBookmark')}
          />
          {saveBookmark ? (
            <>
              <Field label={t('conn.bookmarkName')} error={submitted ? nameError : null} required>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    value={bookmarkName}
                    onChange={(event) => setBookmarkName(event.target.value)}
                  />
                )}
              </Field>
              <Checkbox
                checked={savePassword && vaultReady}
                onCheckedChange={setSavePassword}
                disabled={!vaultReady || password === ''}
                label={t('bookmark.savePassword')}
                hint={vaultReady ? undefined : t('vault.requiredToSave')}
              />
            </>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A labelled group of fields.
 *
 * The old form was one undifferentiated stack, so "where does the server end
 * and the login begin" had no answer. A micro-label plus a fading rule gives
 * the form a rhythm without adding boxes inside boxes.
 */
function FormSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h3 className="flex-none text-2xs uppercase tracking-wider text-text-3">{label}</h3>
        <span className="rule-soft flex-1" />
      </div>
      {children}
    </section>
  );
}
