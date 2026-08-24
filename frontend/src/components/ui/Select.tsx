import { forwardRef, type SelectHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';
import { controlClass } from './Field';
import { Icon } from './Icon';

export interface SelectOption<T extends string> {
  value: T;
  /** Translated. */
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  invalid?: boolean;
}

/**
 * A native `<select>`.
 *
 * `@radix-ui/react-select` is not among the installed packages, and a native
 * select is genuinely better here: full keyboard and type-ahead behaviour for
 * free, and it renders with the platform's own popup — which is what a desktop
 * tool should look like.
 */
function SelectInner<T extends string>(
  { value, onValueChange, options, invalid, className, ...rest }: SelectProps<T>,
  ref: React.Ref<HTMLSelectElement>,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onValueChange(e.target.value as T)}
        className={cn(controlClass, 'cursor-pointer appearance-none pr-6', className)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-text-3"
      />
    </div>
  );
}

export const Select = forwardRef(SelectInner) as <T extends string>(
  props: SelectProps<T> & { ref?: React.Ref<HTMLSelectElement> },
) => React.ReactElement;
