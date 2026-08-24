import { useState, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { errorDetail, errorMessage, useT } from '../../lib/i18n';
import { Button } from './Button';
import { Icon } from './Icon';

export interface ErrorStateProps {
  /**
   * The rejection, normally an `AppError` from `ipc.call`. The localized
   * sentence and the English backend detail are both derived from it.
   */
  error: unknown;
  /** Overrides the localized sentence when the caller has better context. */
  title?: string;
  /** Called by the Retry button. Omit to hide it. */
  onRetry?: () => void;
  /** Extra actions beside Retry, e.g. "Unlock vault". */
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

/**
 * The honest failure state — **required everywhere a fetch can fail**.
 *
 * Three things every failure must show: a localized, actionable sentence; the
 * raw technical detail behind a disclosure (selectable, so it can be pasted
 * into a bug report); and a way to try again.
 */
export function ErrorState({
  error,
  title,
  onRetry,
  action,
  compact = false,
  className,
}: ErrorStateProps) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);

  const primary = title ?? errorMessage(error, t);
  const detail = errorDetail(error);

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'p-4' : 'p-8',
        className,
      )}
    >
      <Icon name="alert-triangle" size={16} className="text-danger" />
      <p className="max-w-md text-base text-text">{primary}</p>

      {detail ? (
        <div className="w-full max-w-md">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="mx-auto inline-flex items-center gap-1 rounded px-1 text-sm text-text-3 hover:text-text-2"
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
            {expanded ? t('common.hideDetails') : t('common.showDetails')}
          </button>
          {expanded ? (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-2 p-2 text-left font-mono text-xs text-text-2">
              {detail}
            </pre>
          ) : null}
        </div>
      ) : null}

      {onRetry || action ? (
        <div className="mt-1 flex items-center gap-2">
          {onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" />}
              onClick={onRetry}
            >
              {t('common.retry')}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}

export interface InlineErrorProps {
  error: unknown;
  className?: string;
}

/** One-line error for a dialog footer or a form, where a full state is too big. */
export function InlineError({ error, className }: InlineErrorProps) {
  const { t } = useT();
  if (error === null || error === undefined) return null;

  const primary = errorMessage(error, t);
  const detail = errorDetail(error);

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-1.5 rounded border border-[var(--danger)] bg-surface-2 px-2 py-1.5 text-left',
        className,
      )}
    >
      <Icon name="alert-circle" className="mt-0.5 flex-none text-danger" />
      <div className="min-w-0">
        <p className="text-base text-text">{primary}</p>
        {detail && detail !== primary ? (
          <p className="mt-0.5 break-words font-mono text-xs text-text-3">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
