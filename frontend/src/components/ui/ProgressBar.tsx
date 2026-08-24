import { cn } from '../../lib/cn';

export type ProgressTone = 'accent' | 'ok' | 'warn' | 'danger' | 'info';

const TONES: Record<ProgressTone, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
};

export interface ProgressBarProps {
  /**
   * Fraction in `[0, 1]`, or `null` for indeterminate — which is exactly what a
   * transfer with `bytesTotal === 0` is. Never fake a percentage.
   */
  value: number | null;
  /** Translated accessible name, e.g. the file being transferred. */
  label: string;
  tone?: ProgressTone;
  /** 2px suits a table row; 6px a dialog. */
  height?: 2 | 4 | 6;
  className?: string;
}

/**
 * Determinate or indeterminate progress with correct ARIA. `aria-valuenow` is
 * set only in the determinate case, so assistive technology reports "busy"
 * rather than a made-up number when the size is unknown.
 */
export function ProgressBar({
  value,
  label,
  tone = 'accent',
  height = 4,
  className,
}: ProgressBarProps) {
  const indeterminate = value === null || !Number.isFinite(value);
  const clamped = indeterminate ? 0 : Math.max(0, Math.min(1, value));
  const percent = Math.round(clamped * 100);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : percent}
      aria-valuetext={indeterminate ? undefined : `${percent}%`}
      aria-busy={indeterminate || undefined}
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-surface-2',
        height === 2 && 'h-0.5',
        height === 4 && 'h-1',
        height === 6 && 'h-1.5',
        className,
      )}
    >
      {indeterminate ? (
        <div
          className={cn('absolute inset-y-0 w-1/3 animate-indeterminate', TONES[tone])}
        />
      ) : (
        <div
          className={cn('h-full transition-quick', TONES[tone])}
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  );
}
