import { forwardRef, type TextareaHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  /** Monospace — for glob lists, key material and command output. */
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, mono, rows = 4, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        rows={rows}
        aria-invalid={invalid || undefined}
        className={cn(
          'w-full resize-y rounded border bg-surface px-2 py-1 text-base text-text',
          'transition-quick disabled:cursor-not-allowed disabled:opacity-60',
          'aria-[invalid=true]:border-danger',
          mono && 'font-mono text-sm',
          className,
        )}
        {...rest}
      />
    );
  },
);
