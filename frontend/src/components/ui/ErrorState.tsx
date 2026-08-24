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
 *
 * It mirrors {@link EmptyState}'s composition on purpose, but in `danger`: the
 * disc is tinted, the icon is a warning, the sentence is at full text colour.
 * Someone glancing at a pane must be able to tell "failed" from "empty" without
 * reading a word — that confusion was the worst bug in the old UI.
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
        'flex h-full flex-col items-center justify-center text-center',
        compact ? 'gap-2 p-5' : 'gap-3 p-10',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex flex-none items-center justify-center rounded-full',
          'border border-[var(--danger)] bg-danger-weak text-danger',
          compact ? 'h-9 w-9' : 'h-12 w-12',
        )}
      >
        <Icon name="alert-triangle" size={16} className={compact ? undefined : 'scale-125'} />
      </span>

      <p
        className={cn(
          'max-w-[46ch] font-medium tracking-tight text-text',
          compact ? 'text-base' : 'text-md',
        )}
      >
        {primary}
      </p>

      {detail ? (
        <div className="w-full max-w-md">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className={cn(
              'press mx-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5',
              'text-xs text-text-3 transition-quick hover:bg-surface-2 hover:text-text-2',
            )}
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
            {expanded ? t('common.hideDetails') : t('common.showDetails')}
          </button>
          {expanded ? (
            <pre
              className={cn(
                'mt-2 max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words',
                'rounded border border-border bg-surface-2 p-2.5 text-left',
                'font-mono text-xs leading-relaxed text-text-2',
                'shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)]',
              )}
            >
              {detail}
            </pre>
          ) : null}
        </div>
      ) : null}

      {onRetry || action ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button variant="secondary" size="sm" icon={<Icon name="refresh" />} onClick={onRetry}>
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
        // Tinted rather than outlined: the fill is what makes an inline error
        // read as an error without depending on the text colour.
        'flex items-start gap-2 rounded border border-[var(--danger)] bg-danger-weak',
        'px-2.5 py-2 text-left',
        className,
      )}
    >
      <Icon name="alert-circle" className="mt-[3px] flex-none text-danger" />
      <div className="min-w-0">
        <p className="text-base leading-snug text-text">{primary}</p>
        {detail && detail !== primary ? (
          <p className="mt-1 break-words font-mono text-xs leading-snug text-text-2">{detail}</p>
        ) : null}
      </div>
    </div>
  );
}
