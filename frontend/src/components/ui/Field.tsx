import { useId, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Icon } from './Icon';

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
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label + control + hint/error, with the ARIA relationships already wired. */
export function Field({ label, hint, error, required = false, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="select-none text-sm font-medium leading-none text-text-2">
        {label}
        {required ? (
          <span className="ml-1 align-middle text-danger" aria-hidden>
            *
          </span>
        ) : null}
      </label>

      {children({ id, describedBy, invalid: Boolean(error) })}

      {error ? (
        // The message is prefixed with an icon, so an invalid field is not
        // signalled by red text alone.
        <p id={errorId} role="alert" className="flex items-start gap-1 text-xs text-danger">
          <Icon name="alert-circle" className="mt-px flex-none" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs leading-snug text-text-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Shared input chrome, so every control looks like the same family.
 *
 * Three deliberate choices here. The field sits on `surface-2` with a top inset
 * shadow, which reads as a well cut into the panel rather than a box drawn on
 * top of it. Focus uses the `shadow-focus` halo instead of the global outline,
 * because an outline is clipped the moment a form lives inside a scrolling
 * dialog body. And `aria-invalid` drives both a `danger` border *and* a danger
 * ring, so the invalid state survives at any colour vision — `Field` adds the
 * icon and the message.
 */
export const controlClass =
  'h-8 w-full rounded border border-border bg-surface-2 px-2.5 text-base text-text ' +
  'shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] transition-quick ' +
  'hover:border-border-strong ' +
  'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border ' +
  'aria-[invalid=true]:border-danger ' +
  'aria-[invalid=true]:shadow-[0_0_0_3px_var(--danger-weak)] ' +
  'aria-[invalid=true]:focus-visible:shadow-[0_0_0_3px_var(--danger-weak),0_0_0_1px_var(--danger)]';
