import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';
import { focusOutline, interactive } from './states';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

/**
 * A real hierarchy, so a dialog footer reads at a glance: exactly one filled
 * accent button, outlined alternatives beside it, ghost for the low-stakes
 * chrome, filled danger only for something irreversible.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border border-accent bg-accent text-accent-fg shadow-e1 hover:bg-accent-hover hover:border-accent-hover',
  secondary: 'border border-border-strong bg-surface text-text shadow-e1 hover:bg-surface-2',
  ghost: 'border border-transparent bg-transparent text-text-2 hover:bg-surface-2 hover:text-text',
  danger: 'border border-danger bg-danger text-accent-fg shadow-e1 hover:opacity-90',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 rounded-sm px-2.5 text-sm',
  md: 'h-8 rounded px-3.5 text-base',
};

const GAPS: Record<ButtonSize, string> = { sm: 'gap-1.5', md: 'gap-2' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Rendered before the label. */
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * The standard action button. `loading` disables interaction and marks the
 * button busy for assistive technology, so a slow command cannot be
 * double-submitted.
 *
 * The spinner is layered *over* the label rather than swapped for it: the label
 * stays in the layout (at zero opacity, so it is still the accessible name) and
 * the button therefore keeps its exact width. A footer that reflows every time
 * someone saves is the cheapest-looking thing a dialog can do.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    className,
    disabled,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'relative inline-flex select-none items-center justify-center whitespace-nowrap',
        'font-medium tracking-tight',
        interactive,
        focusOutline,
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner size={size === 'sm' ? 13 : 15} />
        </span>
      ) : null}
      <span
        className={cn(
          'inline-flex items-center',
          GAPS[size],
          // Not `invisible`: visibility:hidden would drop the label out of the
          // accessibility tree while the button is busy.
          loading && 'opacity-0',
        )}
      >
        {icon}
        {children}
      </span>
    </button>
  );
});
