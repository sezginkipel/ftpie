/* eslint-disable react-refresh/only-export-components --
 * `passwordStrength` is exported so it can be unit tested; it is a pure
 * function and re-exporting it does not affect fast refresh in practice. */
/**
 * The credential vault: first-run setup, unlock, and changing the master
 * password.
 *
 * Opened automatically whenever a command rejects with `vault_locked` (see
 * `uiStore.openDialogForError`), and the pending action is retried through
 * `onUnlocked` once the vault opens. The master password is never stored here —
 * it goes straight to the backend and the field is cleared.
 */
import { useEffect, useState } from 'react';

import { useT } from '../lib/i18n';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import { Button, Dialog, Field, Icon, InlineError, Input, useToast } from './ui';

const MIN_LENGTH = 10;

/** Rough, honest strength signal — length plus character-class variety. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  if (password.length < MIN_LENGTH) return 0;
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;
  if (password.length >= 20 && classes >= 3) return 3;
  if (password.length >= 14 && classes >= 3) return 2;
  return 1;
}

export function VaultDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const { t } = useT();
  const { toast } = useToast();

  const status = useVaultStore((state) => state.status);
  const busy = useVaultStore((state) => state.busy);
  const initialize = useVaultStore((state) => state.initialize);
  const unlock = useVaultStore((state) => state.unlock);
  const changePassword = useVaultStore((state) => state.changePassword);

  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);

  const open = dialog.kind === 'vault';

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setPassword('');
    setConfirm('');
    setError(null);
  }, [open]);

  if (dialog.kind !== 'vault') return null;

  // The requested mode is a hint; the real vault state decides. A `vault_locked`
  // rejection on a machine with no vault yet must offer setup, not unlock.
  const mode =
    dialog.mode === 'change'
      ? 'change'
      : status && !status.initialized
        ? 'initialize'
        : dialog.mode;

  const needsConfirm = mode === 'initialize' || mode === 'change';
  const tooShort = needsConfirm && password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = needsConfirm && confirm.length > 0 && password !== confirm;
  const canSubmit =
    password.length > 0 &&
    !tooShort &&
    (!needsConfirm || (password === confirm && confirm.length > 0)) &&
    (mode !== 'change' || current.length > 0);

  const strength = passwordStrength(password);
  // A four-segment meter: the label alone reads as an opinion, the bar as a fact.
  const strengthLabel = [
    t('vault.strengthWeak'),
    t('vault.strengthFair'),
    t('vault.strengthGood'),
    t('vault.strengthStrong'),
  ][strength];

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      if (mode === 'initialize') {
        await initialize(password);
        toast({ title: t('vault.unlocked'), variant: 'ok' });
      } else if (mode === 'change') {
        await changePassword(current, password);
        toast({ title: t('vault.changed'), variant: 'ok' });
      } else {
        await unlock(password);
        toast({ title: t('vault.unlocked'), variant: 'ok' });
      }
      const retry = dialog.onUnlocked;
      setPassword('');
      setConfirm('');
      setCurrent('');
      closeDialog();
      retry?.();
    } catch (caught) {
      setError(caught);
    }
  };

  const title =
    mode === 'initialize'
      ? t('vault.initTitle')
      : mode === 'change'
        ? t('vault.changePassword')
        : t('vault.unlockTitle');

  const submitLabel =
    mode === 'initialize'
      ? t('vault.initialize')
      : mode === 'change'
        ? t('vault.changePassword')
        : t('vault.unlock');

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={title}
      size="sm"
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
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2 p-3">
          <Icon
            name={mode === 'unlock' ? 'lock' : 'key'}
            size={16}
            className="mt-px flex-none text-accent"
          />
          <p className="min-w-0 text-base text-text-2">
            {mode === 'initialize'
              ? t('vault.initBody')
              : mode === 'change'
                ? t('vault.changePasswordBody')
                : t('vault.unlockBody')}
          </p>
        </div>

        {/* Losing the master password is unrecoverable, so it is a banner. */}
        {mode === 'initialize' ? (
          <div
            role="note"
            className="flex items-start gap-2.5 rounded border border-warn bg-warn-weak p-2.5"
          >
            <Icon name="alert-triangle" size={16} className="mt-px flex-none text-warn" />
            <p className="min-w-0 text-sm text-text">{t('vault.cannotRecover')}</p>
          </div>
        ) : null}

        {mode === 'change' ? (
          <Field label={t('vault.oldPassword')} required>
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="current-password"
                autoFocus
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            )}
          </Field>
        ) : null}

        <Field
          label={mode === 'change' ? t('vault.newPassword') : t('vault.masterPassword')}
          required
          error={tooShort ? t('vault.tooShort', { min: MIN_LENGTH }) : null}
          hint={
            needsConfirm
              ? password.length > 0
                ? t('vault.strength', { level: strengthLabel })
                : t('vault.tooShort', { min: MIN_LENGTH })
              : undefined
          }
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="password"
              autoComplete={needsConfirm ? 'new-password' : 'current-password'}
              autoFocus={mode !== 'change'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>

        {needsConfirm && password.length > 0 ? (
          <div
            className="flex gap-1"
            role="img"
            aria-label={t('vault.strength', { level: strengthLabel })}
          >
            {[0, 1, 2, 3].map((step) => (
              <span
                key={step}
                className={
                  step <= strength
                    ? strength === 0
                      ? 'h-1 flex-1 rounded-full bg-danger'
                      : strength === 1
                        ? 'h-1 flex-1 rounded-full bg-warn'
                        : 'h-1 flex-1 rounded-full bg-ok'
                    : 'h-1 flex-1 rounded-full bg-surface-2'
                }
              />
            ))}
          </div>
        ) : null}

        {needsConfirm ? (
          <Field
            label={t('vault.confirmPassword')}
            required
            error={mismatch ? t('vault.mismatch') : null}
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
        ) : null}
      </form>
    </Dialog>
  );
}
