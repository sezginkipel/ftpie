import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';
import { focusOutline, interactive } from './states';
import type { ButtonVariant } from './Button';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'border border-accent bg-accent text-accent-fg shadow-e1 hover:bg-accent-hover hover:border-accent-hover',
  secondary: 'border border-border-strong bg-surface text-text shadow-e1 hover:bg-surface-2',
  ghost: 'border border-transparent bg-transparent text-text-2 hover:bg-surface-2 hover:text-text',
  // Destructive but low-emphasis: an icon-only delete must not be a red slab in
  // the middle of a toolbar, so it only commits to the tint on hover.
  danger:
    'border border-transparent bg-transparent text-danger hover:bg-danger-weak hover:text-danger',
};

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label' | 'children'
> {
  /**
   * **Required.** Becomes the `aria-label` and the tooltip text — an icon-only
   * control with no accessible name is unusable with a screen reader, so this
   * is deliberately not optional. Pass a translated string from `t()`.
   */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  /** 24px (`sm`) suits a dense toolbar; 28px (`md`) a dialog header. */
  size?: 'sm' | 'md';
  loading?: boolean;
}

/**
 * Square icon-only control. The hit target is grown to the new density (24/28px
 * rather than the old 20/24px) — the old size was under every desktop guideline
 * and made the toolbar feel fiddly.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
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
        'inline-flex flex-none select-none items-center justify-center rounded-sm',
        interactive,
        focusOutline,
        size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={13} /> : icon}
    </button>
  );
});
