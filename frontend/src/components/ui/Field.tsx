import { useId, type ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface FieldProps {
  /** Translated label text. */
  label: string;
  /** Rendered under the control as quiet guidance. */
  hint?: ReactNode;
  /** Inline validation message; replaces the hint and marks the control invalid. */
  error?: string | null;
  required?: boolean;
  className?: string;
  /**
   * Receives the ids to wire onto the control. Using a render prop keeps the
   * label/description association correct without every control re-implementing
   * `aria-describedby`.
   */
  children: (ids: {
    id: string;
    describedBy: string | undefined;
    invalid: boolean;
  }) => ReactNode;
}

/** Label + control + hint/error, with the ARIA relationships already wired. */
export function Field({
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm text-text-2">
        {label}
        {required ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>

      {children({ id, describedBy, invalid: Boolean(error) })}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-text-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Shared input chrome, so every control looks like the same family. */
export const controlClass =
  'h-7 w-full rounded border bg-surface px-2 text-base text-text ' +
  'transition-quick disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-[invalid=true]:border-danger';
