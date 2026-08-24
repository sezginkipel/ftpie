import { cn } from '../../lib/cn';

export interface SpinnerProps {
  size?: number;
  className?: string;
  /**
   * Accessible label. Omit inside a control that already sets `aria-busy` —
   * the spinner is then decorative and announcing it twice is noise.
   */
  label?: string;
}

/**
 * Indeterminate activity indicator: a faint full ring with a rotating arc over
 * it. Honours `prefers-reduced-motion` via the global rule, where it settles
 * into a static ring rather than disappearing.
 */
export function Spinner({ size = 14, className, label }: SpinnerProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn('flex-none animate-spin', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {/* The full ring at low opacity keeps the spinner from looking like a
          stray comma at 13px; the arc on top is what actually reads as motion. */}
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        opacity="0.2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeDasharray="28"
        strokeDashoffset="10"
      />
    </svg>
  );
}
