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
        <label htmlFor={id} className="select-none text-base text-text">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="text-xs text-text-3">
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
          'relative inline-flex h-4 w-7 flex-none items-center rounded-full border transition-quick',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface-2',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'block h-3 w-3 rounded-full transition-quick',
            checked
              ? 'translate-x-[14px] bg-[var(--on-accent)]'
              : 'translate-x-0.5 bg-[var(--text-3)]',
          )}
        />
      </button>
    </div>
  );
}
