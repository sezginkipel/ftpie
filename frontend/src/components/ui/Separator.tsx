import * as RadixSeparator from '@radix-ui/react-separator';

import { cn } from '../../lib/cn';

export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  /** Set when the rule carries meaning rather than being purely visual. */
  semantic?: boolean;
  className?: string;
}

/** A hairline rule. Decorative by default, so it is hidden from the a11y tree. */
export function Separator({
  orientation = 'horizontal',
  semantic = false,
  className,
}: SeparatorProps) {
  return (
    <RadixSeparator.Root
      orientation={orientation}
      decorative={!semantic}
      className={cn(
        'flex-none bg-[var(--border)]',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
    />
  );
}
