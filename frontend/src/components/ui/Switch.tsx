import { useId, type ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Translated label. */
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * `role="switch"` toggle for settings that take effect immediately. Prefer
 * {@link Checkbox} inside a form that has an explicit Save.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled = false,
  className,
}: SwitchProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="select-none text-base leading-snug text-text">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-xs leading-snug text-text-3">
            {hint}
          </p>
        ) : null}
      </div>

      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hintId}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-[18px] w-8 flex-none items-center rounded-full border',
          'press transition-quick',
          'focus-visible:outline-none focus-visible:shadow-focus',
          checked
            ? 'border-accent bg-accent'
            : cn(
                'border-border-strong bg-surface-2 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]',
                !disabled && 'hover:border-accent',
              ),
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {/* The knob carries its own tiny elevation, which is what makes the
            track read as a groove and the knob as a thing sitting in it. */}
        <span
          aria-hidden
          className={cn(
            'block h-3.5 w-3.5 rounded-full shadow-e1 transition-base',
            checked
              ? 'translate-x-[15px] bg-[var(--on-accent)]'
              : 'translate-x-0.5 bg-[var(--text-3)]',
          )}
        />
      </button>
    </div>
  );
}
