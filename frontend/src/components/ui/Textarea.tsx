import { forwardRef, type TextareaHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Monospace — for glob lists, key material and command output. */
  mono?: boolean;
}

/**
 * Multi-line input. Shares the inset well, the halo focus and the non-colour-only
 * invalid treatment with {@link controlClass}, but cannot reuse it directly
 * because a textarea has no fixed height.
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, mono, rows = 4, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full resize-y rounded border border-border bg-surface-2 px-2.5 py-1.5',
        'text-base leading-relaxed text-text',
        'shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] transition-quick',
        'hover:border-border-strong',
        'focus-visible:border-accent focus-visible:shadow-focus focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-danger',
        'aria-[invalid=true]:shadow-[0_0_0_3px_var(--danger-weak)]',
        'aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_var(--danger-weak),0_0_0_1px_var(--danger)]',
        mono && 'font-mono text-sm',
        className,
      )}
      {...rest}
    />
  );
});
