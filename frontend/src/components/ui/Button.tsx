import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg border border-accent hover:opacity-90 disabled:opacity-50',
  secondary:
    'bg-surface text-text border border-border-strong hover:bg-surface-2 disabled:opacity-50',
  ghost:
    'bg-transparent text-text-2 border border-transparent hover:bg-surface-2 hover:text-text disabled:opacity-50',
  danger:
    'bg-danger text-accent-fg border border-danger hover:opacity-90 disabled:opacity-50',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-sm gap-1',
  md: 'h-7 px-3 text-base gap-1.5',
};

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
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded',
        'transition-quick disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
});
