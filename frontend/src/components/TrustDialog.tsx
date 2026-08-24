/**
 * Trust-on-first-use, the security-critical half of connecting.
 *
 * The backend refuses to talk to a host whose identity it has not pinned and
 * rejects with `untrusted_host` carrying the fingerprint. This dialog is the
 * only place that fingerprint is shown, so it has to be readable and it has to
 * be honest about the two very different situations:
 *
 * - **New host.** Compare and accept. The primary action is "trust", and the
 *   framing is informational.
 * - **Changed fingerprint.** Indistinguishable from an interception attempt from
 *   here, so the whole surface changes: a `danger` banner, both fingerprints
 *   side by side, and *Cancel* as the primary button — trusting is the
 *   deliberate, secondary choice.
 *
 * The fingerprint itself is the thing a person has to compare by eye, so it is
 * set in monospace, split into chunks with real space between them, fully
 * selectable, and copyable in one click.
 */
import { useState } from 'react';

import { chunkFingerprint } from '../lib/format';
import { useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import { useUiStore } from '../store/uiStore';
import { Button, Dialog, Icon, IconButton, InlineError, useToast } from './ui';

export function TrustDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const { t } = useT();
  const { toast } = useToast();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (dialog.kind !== 'trust') return null;

  const { host, port, trustKind, algorithm, fingerprint, previousFingerprint, message, onTrusted } =
    dialog;
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
      className="press"
      icon={<Icon name={changed ? 'shield-alert' : 'shield'} />}
      onClick={() => void accept()}
    >
      {changed ? t('trust.acceptChanged') : t('trust.accept')}
    </Button>
  );

  const cancelButton = (
    <Button
      variant={changed ? 'primary' : 'secondary'}
      onClick={closeDialog}
      disabled={busy}
      className="press"
    >
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
        <span
          className={
            changed
              ? 'flex flex-none items-center gap-1.5 rounded-sm bg-danger-weak px-2 py-1 text-2xs uppercase tracking-wider text-danger'
              : 'flex flex-none items-center gap-1.5 rounded-sm bg-info-weak px-2 py-1 text-2xs uppercase tracking-wider text-info'
          }
        >
          <Icon name={changed ? 'shield-alert' : 'shield'} />
          {changed ? t('common.warning') : t('trust.firstContact')}
        </span>
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
      <div className="flex flex-col gap-4">
        {/*
         * The changed case leads with the accusation, not with metadata. On a
         * first contact the same slot is a calm informational note, so the two
         * situations cannot be mistaken for each other at a glance.
         */}
        {changed ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-[var(--danger)] bg-danger-weak p-3">
            <Icon name="shield-alert" size={16} className="mt-px flex-none text-danger" />
            <div className="min-w-0">
              <p className="text-base font-semibold tracking-tight text-text">
                {t('trust.bodyChanged', { host })}
              </p>
              <p className="mt-1 text-sm text-text-2">{t('trust.interceptionWarning')}</p>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-info-weak p-3">
            <Icon name="shield" size={16} className="mt-px flex-none text-info" />
            <p className="min-w-0 text-base text-text">{t('trust.body', { host })}</p>
          </div>
        )}

        {/* Identity metadata: quiet, tabular, monospace where it is a value. */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded border border-border bg-surface-2 px-3 py-2 text-sm">
          <dt className="text-2xs uppercase tracking-wider text-text-3">{t('trust.host')}</dt>
          <dd className="select-text font-mono tnum text-text">
            {host}:{port}
          </dd>
          <dt className="text-2xs uppercase tracking-wider text-text-3">{t('trust.kind')}</dt>
          <dd className="text-text">{t(`trust.kind.${trustKind}`)}</dd>
          <dt className="text-2xs uppercase tracking-wider text-text-3">{t('trust.algorithm')}</dt>
          <dd className="select-text font-mono text-text">{algorithm}</dd>
        </dl>

        <div className="flex flex-col gap-2.5">
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
              tone="muted"
              copyLabel={t('trust.copyFingerprint')}
              onCopy={copy}
            />
          ) : null}

          <p className="text-sm text-text-2">{t('trust.compareInstruction')}</p>
        </div>

        <div className="rule-soft" />

        <p className="text-sm text-text-2">
          {changed ? t('trust.decisionHelp') : t('trust.explain')}
        </p>

        {message ? (
          <p className="select-text break-words font-mono text-xs text-text-3">{message}</p>
        ) : null}
      </div>
    </Dialog>
  );
}

type FingerprintTone = 'danger' | 'neutral' | 'muted';

const FINGERPRINT_FRAME: Record<FingerprintTone, string> = {
  danger: 'border-[var(--danger)] bg-danger-weak',
  neutral: 'border-border-strong bg-surface-2',
  muted: 'border-border bg-surface-2',
};

const FINGERPRINT_TEXT: Record<FingerprintTone, string> = {
  danger: 'text-text',
  neutral: 'text-text',
  muted: 'text-text-2',
};

interface FingerprintBlockProps {
  label: string;
  value: string;
  tone: FingerprintTone;
  copyLabel: string;
  onCopy: (value: string) => void;
}

/**
 * Chunked, selectable, copyable — a fingerprint that can actually be compared.
 *
 * Each chunk is its own element with visible space around it, because a 64-char
 * unbroken hex run is exactly the thing an eye skips over. `select-all` on the
 * container still copies the whole value in one gesture.
 */
function FingerprintBlock({ label, value, tone, copyLabel, onCopy }: FingerprintBlockProps) {
  const chunked = chunkFingerprint(value);
  const [prefix, ...rest] = chunked.split(':');
  const body = rest.join(':').trim();
  const chunks = body === '' ? [] : body.split(' ');

  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-wider text-text-3">{label}</span>
      <div className={`flex items-start gap-2 rounded border p-2.5 ${FINGERPRINT_FRAME[tone]}`}>
        <code
          className={`min-w-0 flex-1 select-all font-mono text-sm leading-relaxed ${FINGERPRINT_TEXT[tone]}`}
        >
          {chunks.length === 0 ? (
            <span className="break-all">{chunked}</span>
          ) : (
            <>
              <span className="mr-2 text-text-3">{prefix}</span>
              <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5 align-top">
                {chunks.map((chunk, index) => (
                  <span key={`${index}-${chunk}`}>{chunk}</span>
                ))}
              </span>
            </>
          )}
        </code>
        <IconButton
          label={copyLabel}
          icon={<Icon name="copy" />}
          size="sm"
          className="press"
          onClick={() => onCopy(value)}
        />
      </div>
    </div>
  );
}
