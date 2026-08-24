import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  /** Translated title, e.g. "This folder is empty". */
  title: string;
  /** Translated supporting line. */
  description?: string;
  icon?: IconName;
  /** A `Button` offering the obvious next step. */
  action?: ReactNode;
  /** Tighter padding, for a small panel. */
  compact?: boolean;
  className?: string;
}

/**
 * "There is genuinely nothing here."
 *
 * This must never be used for a failure — a failed listing gets an
 * {@link ErrorState}. Rendering errors as "Empty directory" was the most
 * misleading bug in the old UI.
 *
 * The composition is deliberate and fixed: a muted icon inside a tinted disc,
 * a title at full text weight, one quiet line of guidance, then the action. An
 * empty pane is one of the first things a new user sees, so it gets composed
 * like a piece of the product rather than a fallback.
 */
export function EmptyState({
  title,
  description,
  icon = 'folder',
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
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
          'border border-border bg-surface-2 text-text-3',
          compact ? 'h-9 w-9' : 'h-12 w-12',
        )}
      >
        <Icon name={icon} size={16} className={compact ? undefined : 'scale-125'} />
      </span>

      <div className={cn('flex flex-col', compact ? 'gap-0.5' : 'gap-1')}>
        <p
          className={cn('font-medium tracking-tight text-text', compact ? 'text-base' : 'text-md')}
        >
          {title}
        </p>
        {description ? (
          <p className="mx-auto max-w-[34ch] text-sm leading-snug text-text-3">{description}</p>
        ) : null}
      </div>

      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
