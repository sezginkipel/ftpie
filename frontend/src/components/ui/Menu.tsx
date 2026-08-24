import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/** One entry in a {@link Menu} or {@link ContextMenu}. */
export type MenuItem =
  | {
      kind?: 'item';
      /** Stable key. */
      id: string;
      /** Translated label. */
      label: string;
      icon?: ReactNode;
      /** Right-aligned hint, usually a shortcut. */
      shortcut?: string;
      disabled?: boolean;
      /** Renders in danger colour; use for destructive entries. */
      danger?: boolean;
      onSelect: () => void;
    }
  | {
      kind: 'checkbox';
      id: string;
      label: string;
      checked: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: 'separator'; id: string }
  | { kind: 'label'; id: string; label: string };

export const menuContentClass =
  'z-50 min-w-[180px] overflow-hidden rounded border border-border-strong bg-surface py-1 shadow-xl';

export const menuItemClass =
  'flex h-6 cursor-default select-none items-center gap-2 px-2 text-base text-text ' +
  'outline-none data-[highlighted]:bg-accent-weak data-[disabled]:pointer-events-none ' +
  'data-[disabled]:text-text-3';

export interface MenuProps {
  /** The control that opens the menu. Must be focusable. */
  trigger: ReactNode;
  items: MenuItem[];
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Translated accessible name for the menu itself. */
  label: string;
}

/**
 * Dropdown menu on Radix, so arrow-key navigation, type-ahead, Escape and
 * focus return all work. Rendering from a data array keeps every call site
 * consistent and makes the items trivially translatable.
 */
export function Menu({ trigger, items, align = 'start', side = 'bottom', label }: MenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label={label}
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          className={menuContentClass}
        >
          {items.map((item) => renderItem(item))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function renderItem(item: MenuItem): ReactNode {
  if (item.kind === 'separator') {
    return (
      <DropdownMenu.Separator key={item.id} className="my-1 h-px bg-[var(--border)]" />
    );
  }

  if (item.kind === 'label') {
    return (
      <DropdownMenu.Label
        key={item.id}
        className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-text-3"
      >
        {item.label}
      </DropdownMenu.Label>
    );
  }

  if (item.kind === 'checkbox') {
    return (
      <DropdownMenu.CheckboxItem
        key={item.id}
        checked={item.checked}
        disabled={item.disabled}
        onSelect={item.onSelect}
        className={menuItemClass}
      >
        <span className="w-3.5 text-accent">{item.checked ? '✓' : ''}</span>
        <span className="flex-1 truncate">{item.label}</span>
      </DropdownMenu.CheckboxItem>
    );
  }

  return (
    <DropdownMenu.Item
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
    </DropdownMenu.Item>
  );
}
