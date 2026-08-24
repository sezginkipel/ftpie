import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** Mount once near the app root. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    // 300ms is long enough that a tooltip never flickers while the pointer
    // crosses a toolbar, short enough that deliberately resting on a control
    // feels answered. Once one has opened, neighbours show instantly.
    <RadixTooltip.Provider delayDuration={300} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  /** Translated content. Keep it short; it is not a place for instructions. */
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Monospace body — for paths and symlink targets. */
  mono?: boolean;
  /** Suppress without changing the tree shape. */
  disabled?: boolean;
}

/**
 * Hover/focus tooltip.
 *
 * A tooltip is never the only way to reach information: it supplements a
 * control that already has an accessible name. Radix exposes the content via
 * `aria-describedby` and shows it on keyboard focus too.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  mono = false,
  disabled = false,
}: TooltipProps) {
  if (disabled || content === null || content === undefined || content === '') {
    return <>{children}</>;
  }

  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={[
            'raised z-50 max-w-sm animate-menu-in rounded px-2 py-1',
            'text-sm leading-snug text-text shadow-e3',
            mono ? 'break-all font-mono' : '',
          ].join(' ')}
        >
          {content}
          <RadixTooltip.Arrow
            width={10}
            height={5}
            className="fill-[var(--surface-3)] stroke-[var(--border-strong)]"
          />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
