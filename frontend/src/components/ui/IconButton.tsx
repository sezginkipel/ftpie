import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';
import type { ButtonVariant } from './Button';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg border border-accent hover:opacity-90',
  secondary: 'bg-surface text-text border border-border-strong hover:bg-surface-2',
  ghost:
    'bg-transparent text-text-2 border border-transparent hover:bg-surface-2 hover:text-text',
  danger: 'bg-transparent text-danger border border-transparent hover:bg-surface-2',
};

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /**
   * **Required.** Becomes the `aria-label` and the tooltip text — an icon-only
   * control with no accessible name is unusable with a screen reader, so this
   * is deliberately not optional. Pass a translated string from `t()`.
   */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  /** 20px (`sm`) suits a dense toolbar; 24px (`md`) a dialog header. */
  size?: 'sm' | 'md';
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      variant = 'ghost',
      size = 'sm',
      loading = false,
      className,
      disabled,
      type = 'button',
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          'inline-flex flex-none select-none items-center justify-center rounded',
          'transition-quick disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' ? 'h-5 w-5' : 'h-6 w-6',
          VARIANTS[variant],
          className,
        )}
        {...rest}
      >
        {loading ? <Spinner size={12} /> : icon}
      </button>
    );
  },
);
