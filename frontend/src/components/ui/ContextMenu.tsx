import * as RadixContextMenu from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import {
  MenuCheckBody,
  MenuItemBody,
  menuContentClass,
  menuDangerClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
  type MenuItem,
} from './Menu';

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
 * activation via the context-menu key. Shares the item shape *and the item
 * rendering* with {@link Menu}, so the same action looks identical wherever the
 * user reaches it.
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
    return <RadixContextMenu.Separator key={item.id} className={menuSeparatorClass} />;
  }

  if (item.kind === 'label') {
    return (
      <RadixContextMenu.Label key={item.id} className={menuLabelClass}>
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
        <MenuCheckBody checked={item.checked} label={item.label} />
      </RadixContextMenu.CheckboxItem>
    );
  }

  return (
    <RadixContextMenu.Item
      key={item.id}
      disabled={item.disabled}
      onSelect={item.onSelect}
      className={cn(menuItemClass, item.danger && menuDangerClass)}
    >
      <MenuItemBody icon={item.icon} label={item.label} shortcut={item.shortcut} />
    </RadixContextMenu.Item>
  );
}
