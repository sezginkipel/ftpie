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

/** Indeterminate activity indicator. Honours `prefers-reduced-motion`. */
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
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="28"
        strokeDashoffset="10"
        opacity="0.9"
      />
    </svg>
  );
}
