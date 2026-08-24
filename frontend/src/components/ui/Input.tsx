import { forwardRef, type InputHTMLAttributes } from 'react';

import { cn } from '../../lib/cn';
import { controlClass } from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Use the monospace stack — for paths, hosts, hashes and fingerprints. */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, mono, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(controlClass, mono && 'font-mono text-sm', className)}
      {...rest}
    />
  );
});
