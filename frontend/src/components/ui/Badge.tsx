import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border-strong bg-surface-2 text-text-2',
  accent: 'border-accent bg-accent-weak text-accent',
  ok: 'border-[var(--ok)] bg-transparent text-ok',
  warn: 'border-[var(--warn)] bg-transparent text-warn',
  danger: 'border-[var(--danger)] bg-transparent text-danger',
  info: 'border-[var(--info)] bg-transparent text-info',
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /** Tabular numerals and the monospace stack — for counts and hashes. */
  mono?: boolean;
  className?: string;
}

/** Compact status pill. Never the only carrier of meaning — pair it with text. */
export function Badge({ children, tone = 'neutral', mono = false, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-4 flex-none items-center rounded border px-1 text-2xs uppercase tracking-wide',
        mono && 'font-mono normal-case tnum',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
