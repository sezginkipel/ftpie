import { forwardRef, useCallback, type InputHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';
import { controlClass } from './Field';

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: number | null;
  /**
   * Called with a parsed integer, or `null` when the field is empty or the
   * text is not a number. **It is never called with `NaN`** — the old port
   * field sent `parseInt('')` straight to the backend.
   */
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  invalid?: boolean;
}

/**
 * Numeric input that clamps to `[min, max]` and never emits `NaN`. The value is
 * kept as a controlled string-free number so the caller does not have to guard.
 */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    { value, onValueChange, min, max, invalid, className, ...rest },
    ref,
  ) {
    const handleChange = useCallback(
      (raw: string) => {
        const trimmed = raw.trim();
        if (trimmed === '') {
          onValueChange(null);
          return;
        }
        // Reject anything that is not a plain integer rather than letting
        // parseInt salvage a prefix ("12abc" must not become 12).
        if (!/^-?\d+$/.test(trimmed)) return;
        let next = Number.parseInt(trimmed, 10);
        if (!Number.isFinite(next)) return;
        if (min !== undefined && next < min) next = min;
        if (max !== undefined && next > max) next = max;
        onValueChange(next);
      },
      [max, min, onValueChange],
    );

    return (
      <input
        ref={ref}
        type="number"
        inputMode="numeric"
        value={value === null ? '' : String(value)}
        min={min}
        max={max}
        aria-invalid={invalid || undefined}
        onChange={(e) => handleChange(e.target.value)}
        className={cn(controlClass, 'tnum', className)}
        {...rest}
      />
    );
  },
);
