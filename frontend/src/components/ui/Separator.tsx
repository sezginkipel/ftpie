import * as RadixSeparator from '@radix-ui/react-separator';

import { cn } from '../../lib/cn';

export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  /** Set when the rule carries meaning rather than being purely visual. */
  semantic?: boolean;
  className?: string;
}

/**
 * A hairline rule. Decorative by default, so it is hidden from the a11y tree.
 *
 * A horizontal rule uses `.rule-soft`, which fades out at both ends — a rule
 * that runs hard into the panel's rounded corners is one of the things that made
 * the old chrome look boxy. A vertical one (a toolbar divider) stays solid,
 * since it is short enough not to need it.
 */
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
        'flex-none',
        orientation === 'horizontal' ? 'rule-soft w-full' : 'my-1 h-full w-px bg-[var(--border)]',
        className,
      )}
    />
  );
}
