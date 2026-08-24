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
        'flex flex-col items-center justify-center gap-1.5 text-center',
        compact ? 'p-4' : 'p-8',
        className,
      )}
    >
      <Icon name={icon} size={16} className="text-text-3" />
      <p className="text-base text-text-2">{title}</p>
      {description ? (
        <p className="max-w-xs text-sm text-text-3">{description}</p>
      ) : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </div>
  );
}
