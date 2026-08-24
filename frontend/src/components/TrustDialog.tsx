/**
 * Trust-on-first-use, the security-critical half of connecting.
 *
 * The backend refuses to talk to a host whose identity it has not pinned and
 * rejects with `untrusted_host` carrying the fingerprint. This dialog is the
 * only place that fingerprint is shown, so it has to be readable and it has to
 * be honest about the two very different situations:
 *
 * - **New host.** Compare and accept. The primary action is "trust".
 * - **Changed fingerprint.** Indistinguishable from an interception attack from
 *   here, so the styling is `danger`, both fingerprints are shown, and the
 *   primary button is *Cancel* — trusting is the deliberate, secondary choice.
 */
import { useState } from 'react';

import { chunkFingerprint } from '../lib/format';
import { useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import { useUiStore } from '../store/uiStore';
import { Badge, Button, Dialog, Icon, IconButton, InlineError, useToast } from './ui';

export function TrustDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const { t } = useT();
  const { toast } = useToast();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (dialog.kind !== 'trust') return null;

  const {
    host,
    port,
    trustKind,
    algorithm,
    fingerprint,
    previousFingerprint,
    message,
    onTrusted,
  } = dialog;
  const changed = previousFingerprint !== null;

  const copy = (value: string) => {
    navigator.clipboard
      ?.writeText(value)
      .then(() => toast({ title: t('toast.copiedToClipboard'), variant: 'ok' }))
      .catch(() => toast({ title: t('toast.copyFailed'), variant: 'warn' }));
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await call<void>('trust_host', {
        host,
        port,
        kind: trustKind,
        fingerprint,
        algorithm,
      });
      toast({ title: t('trust.trusted', { host }), variant: 'ok' });
      closeDialog();
      // Retrying is the caller's business: it knows what it was doing.
      onTrusted?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const trustButton = (
    <Button
      variant={changed ? 'danger' : 'primary'}
      loading={busy}
      onClick={() => void accept()}
    >
      {changed ? t('trust.acceptChanged') : t('trust.accept')}
    </Button>
  );

  const cancelButton = (
    <Button variant={changed ? 'primary' : 'secondary'} onClick={closeDialog} disabled={busy}>
      {t('trust.reject')}
    </Button>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={changed ? t('trust.titleChanged') : t('trust.title')}
      size="md"
      headerExtra={
        changed ? <Badge tone="danger">{t('common.warning')}</Badge> : null
      }
      footer={
        <>
          <InlineError error={error} className="mr-auto" />
          {/* On a changed fingerprint, Cancel is the primary action and sits
              last, where the eye and the Enter key land. */}
          {changed ? (
            <>
              {trustButton}
              {cancelButton}
            </>
          ) : (
            <>
              {cancelButton}
              {trustButton}
            </>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-base text-text">
          {changed ? t('trust.bodyChanged', { host }) : t('trust.body', { host })}
        </p>

        {changed ? (
          <div className="flex items-start gap-2 rounded border border-[var(--danger)] bg-surface-2 p-2">
            <Icon name="shield-alert" size={16} className="mt-0.5 flex-none text-danger" />
            <p className="text-sm text-text">{t('trust.interceptionWarning')}</p>
          </div>
        ) : null}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-text-3">{t('trust.host')}</dt>
          <dd className="font-mono text-text">
            {host}:{port}
          </dd>
          <dt className="text-text-3">{t('trust.kind')}</dt>
          <dd className="text-text">{t(`trust.kind.${trustKind}`)}</dd>
          <dt className="text-text-3">{t('trust.algorithm')}</dt>
          <dd className="font-mono text-text">{algorithm}</dd>
        </dl>

        <FingerprintBlock
          label={changed ? t('trust.fingerprintNew') : t('trust.fingerprint')}
          value={fingerprint}
          tone={changed ? 'danger' : 'neutral'}
          copyLabel={t('trust.copyFingerprint')}
          onCopy={copy}
        />

        {previousFingerprint ? (
          <FingerprintBlock
            label={t('trust.fingerprintPrevious')}
            value={previousFingerprint}
            tone="neutral"
            copyLabel={t('trust.copyFingerprint')}
            onCopy={copy}
          />
        ) : null}

        <p className="text-sm text-text-2">{t('trust.explain')}</p>

        {message ? (
          <p className="break-words font-mono text-xs text-text-3">{message}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

interface FingerprintBlockProps {
  label: string;
  value: string;
  tone: 'danger' | 'neutral';
  copyLabel: string;
  onCopy: (value: string) => void;
}

/** Chunked, selectable, copyable — a fingerprint that can actually be compared. */
function FingerprintBlock({ label, value, tone, copyLabel, onCopy }: FingerprintBlockProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-text-3">{label}</span>
      <div
        className={
          tone === 'danger'
            ? 'flex items-start gap-2 rounded border border-[var(--danger)] bg-surface-2 p-2'
            : 'flex items-start gap-2 rounded border border-border bg-surface-2 p-2'
        }
      >
        <code className="min-w-0 flex-1 select-all break-all font-mono text-sm text-text">
          {chunkFingerprint(value)}
        </code>
        <IconButton
          label={copyLabel}
          icon={<Icon name="copy" />}
          size="sm"
          onClick={() => onCopy(value)}
        />
      </div>
    </div>
  );
}
