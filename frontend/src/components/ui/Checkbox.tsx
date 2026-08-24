import { useId, type ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Icon } from './Icon';

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Translated label. Always required — an unlabelled checkbox is unusable. */
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
  /** Renders the mixed state; treated as unchecked when toggled. */
  indeterminate?: boolean;
  className?: string;
  id?: string;
}

/**
 * A real `<input type="checkbox">` behind a styled box, so Space, form
 * semantics and screen-reader state all work without reimplementation.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled = false,
  indeterminate = false,
  className,
  id: providedId,
}: CheckboxProps) {
  const generated = useId();
  const id = providedId ?? generated;
  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2.5">
        <span className="relative inline-flex h-[17px] w-[17px] flex-none items-center justify-center">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-checked={indeterminate ? 'mixed' : checked}
            aria-describedby={hintId}
            onChange={(e) => onCheckedChange(e.target.checked)}
            className="peer absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          />
          <span
            aria-hidden
            className={cn(
              'pointer-events-none flex h-[17px] w-[17px] items-center justify-center',
              'rounded-sm border transition-quick',
              // The halo follows the radius; an outline on a 5px box looks like
              // a notch, and gets clipped inside a scrolling dialog body.
              'peer-focus-visible:border-accent peer-focus-visible:shadow-focus',
              checked || indeterminate
                ? 'border-accent bg-accent text-accent-fg shadow-e1'
                : cn(
                    'border-border-strong bg-surface-2',
                    'shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)]',
                    !disabled && 'peer-hover:border-accent',
                  ),
              disabled && 'opacity-50',
            )}
          >
            {indeterminate ? <Icon name="minus" /> : checked ? <Icon name="check" /> : null}
          </span>
        </span>

        <label
          htmlFor={id}
          className={cn(
            'select-none text-base leading-snug',
            disabled ? 'cursor-not-allowed text-text-3' : 'cursor-pointer text-text',
          )}
        >
          {label}
        </label>
      </div>

      {hint ? (
        <p id={hintId} className="pl-[27px] text-xs leading-snug text-text-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
