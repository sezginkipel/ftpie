import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

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
 *
 * The active tab is marked by a single underline element that slides and resizes
 * between tabs rather than each tab swapping its own border on and off. That is
 * what makes a tab strip feel like a physical control: the indicator is one
 * object that moves, so the eye can follow it and knows where it came from.
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
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

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
      listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(next.id))}`)?.focus();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, value, onValueChange, baseId],
  );

  // Measured from the DOM rather than derived from the label length, so the
  // underline is correct for any font, any translation and any icon.
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (!active) {
      setIndicator(null);
      return;
    }
    setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, []);

  useLayoutEffect(measure, [measure, value, tabs]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [measure]);

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
        className="relative flex flex-none items-center gap-1 border-b border-border"
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
                'relative inline-flex h-9 select-none items-center gap-1.5 rounded-t-sm px-3',
                'text-base font-medium tracking-tight transition-quick',
                'focus-visible:outline-2 focus-visible:outline-offset-[-3px]',
                'disabled:cursor-not-allowed disabled:opacity-50',
                selected ? 'text-text' : 'text-text-2 hover:bg-surface-2 hover:text-text',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}

        {/* The sliding indicator. Decorative — `aria-selected` is what a screen
            reader uses. Its transition is a plain CSS one, so the global
            reduced-motion rule flattens it to an instant jump. */}
        {indicator ? (
          <span
            aria-hidden
            className="absolute -bottom-px h-[2px] rounded-full bg-accent transition-base"
            style={{ left: indicator.left, width: indicator.width }}
          />
        ) : null}
      </div>

      <div
        id={panelId(value)}
        role="tabpanel"
        aria-labelledby={tabId(value)}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4 focus-visible:outline-none"
      >
        {children}
      </div>
    </div>
  );
}
