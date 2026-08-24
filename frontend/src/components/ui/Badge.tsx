import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

/**
 * Every tone is a tinted fill plus a matching border and text colour. The old
 * badges were transparent with a coloured outline, which meant "connected" and
 * "failed" differed only in hue — unreadable for a colour-blind user and washed
 * out on a light theme. The `*-weak` backgrounds exist precisely for this.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border-strong bg-surface-2 text-text-2',
  accent: 'border-accent-line bg-accent-weak text-accent',
  // Solid semantic borders, not translucent ones: Tailwind cannot apply an
  // opacity modifier to an arbitrary `var()` colour, so `/35` would silently
  // compile to nothing and the border would fall back to the neutral hairline.
  ok: 'border-[var(--ok)] bg-ok-weak text-ok',
  warn: 'border-[var(--warn)] bg-warn-weak text-warn',
  danger: 'border-[var(--danger)] bg-danger-weak text-danger',
  info: 'border-[var(--info)] bg-info-weak text-info',
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
        'inline-flex h-[18px] flex-none items-center rounded-sm border px-1.5',
        'text-2xs font-semibold uppercase leading-none tracking-wide',
        mono && 'font-mono normal-case tracking-normal tnum',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
