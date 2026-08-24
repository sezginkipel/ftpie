import { useCallback, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface TabDefinition<T extends string> {
  id: T;
  /** Translated label. */
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabDefinition<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Translated accessible name for the tab list. */
  label: string;
  /** The active tab's panel content. */
  children: ReactNode;
  className?: string;
}

/**
 * A tab list implementing the ARIA tabs pattern by hand.
 *
 * `@radix-ui/react-tabs` is not among the installed packages, so this provides
 * the same behaviour: one tab stop for the whole list (roving `tabindex`),
 * Left/Right to move, Home/End to jump, and `aria-controls`/`aria-labelledby`
 * tying each tab to its panel.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onValueChange,
  label,
  children,
  className,
}: TabsProps<T>) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  const move = useCallback(
    (delta: number | 'first' | 'last') => {
      const selectable = tabs.filter((tab) => !tab.disabled);
      if (selectable.length === 0) return;

      let next: TabDefinition<T>;
      if (delta === 'first') {
        next = selectable[0];
      } else if (delta === 'last') {
        next = selectable[selectable.length - 1];
      } else {
        const current = selectable.findIndex((tab) => tab.id === value);
        const index = (current + delta + selectable.length) % selectable.length;
        next = selectable[index];
      }

      onValueChange(next.id);
      // Focus follows selection, which is the expected behaviour for automatic
      // activation tabs.
      listRef.current
        ?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(next.id))}`)
        ?.focus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, value, onValueChange, baseId],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        move('first');
        break;
      case 'End':
        event.preventDefault();
        move('last');
        break;
      default:
        break;
    }
  };

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex flex-none items-center gap-0.5 border-b border-border"
      >
        {tabs.map((tab) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              id={tabId(tab.id)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              disabled={tab.disabled}
              onClick={() => onValueChange(tab.id)}
              className={cn(
                'inline-flex h-7 select-none items-center gap-1.5 border-b-2 px-2.5 text-base transition-quick',
                'disabled:cursor-not-allowed disabled:opacity-50',
                selected
                  ? 'border-accent text-text'
                  : 'border-transparent text-text-2 hover:text-text',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id={panelId(value)}
        role="tabpanel"
        aria-labelledby={tabId(value)}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto pt-3"
      >
        {children}
      </div>
    </div>
  );
}
