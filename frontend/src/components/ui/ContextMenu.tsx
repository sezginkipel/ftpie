import * as RadixContextMenu from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { menuContentClass, menuItemClass, type MenuItem } from './Menu';

export interface ContextMenuProps {
  /** The region that opens the menu on right-click (or the context key). */
  children: ReactNode;
  items: MenuItem[];
  /** Translated accessible name. */
  label: string;
  /** Suppress the menu entirely, e.g. over an empty pane. */
  disabled?: boolean;
  className?: string;
}

/**
 * Right-click menu on Radix, with full arrow-key navigation and keyboard
 * activation via the context-menu key. Shares the item shape with {@link Menu}
 * so a call site can offer the same actions in both places.
 */
export function ContextMenu({
  children,
  items,
  label,
  disabled = false,
  className,
}: ContextMenuProps) {
  if (disabled) return <>{children}</>;

  return (
    <RadixContextMenu.Root>
      <RadixContextMenu.Trigger asChild={false} className={className}>
        {children}
      </RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          aria-label={label}
          collisionPadding={8}
          className={menuContentClass}
        >
          {items.map((item) => renderItem(item))}
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}

function renderItem(item: MenuItem): ReactNode {
  if (item.kind === 'separator') {
    return (
      <RadixContextMenu.Separator
        key={item.id}
        className="my-1 h-px bg-[var(--border)]"
      />
    );
  }

  if (item.kind === 'label') {
    return (
      <RadixContextMenu.Label
        key={item.id}
        className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-text-3"
      >
        {item.label}
      </RadixContextMenu.Label>
    );
  }

  if (item.kind === 'checkbox') {
    return (
      <RadixContextMenu.CheckboxItem
        key={item.id}
        checked={item.checked}
        disabled={item.disabled}
        onSelect={item.onSelect}
        className={menuItemClass}
      >
        <span className="w-3.5 text-accent">{item.checked ? '✓' : ''}</span>
        <span className="flex-1 truncate">{item.label}</span>
      </RadixContextMenu.CheckboxItem>
    );
  }

  return (
    <RadixContextMenu.Item
      key={item.id}
      disabled={item.disabled}
      onSelect={item.onSelect}
      className={cn(menuItemClass, item.danger && 'text-danger')}
    >
      {item.icon ? (
        <span className="flex w-3.5 justify-center">{item.icon}</span>
      ) : (
        <span className="w-3.5" />
      )}
      <span className="flex-1 truncate">{item.label}</span>
      {item.shortcut ? (
        <span className="ml-3 font-mono text-xs text-text-3">{item.shortcut}</span>
      ) : null}
    </RadixContextMenu.Item>
  );
}
