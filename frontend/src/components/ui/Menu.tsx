import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { Icon } from './Icon';

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

/**
 * The floating menu surface. `.raised` carries the surface, border and elevation
 * together; the 4px padding is what lets each item show its own rounded
 * highlight instead of a full-bleed bar that fights the panel's corners.
 */
export const menuContentClass =
  'raised z-50 min-w-[204px] max-w-[min(92vw,22rem)] animate-menu-in ' + 'rounded-lg p-1 shadow-e3';

/**
 * A menu row at the new density: 28px tall, which is comfortable to hit without
 * turning a 12-entry context menu into a scroller. Highlight is a tinted accent
 * background rather than a colour swap, so it survives at any contrast setting.
 */
export const menuItemClass =
  'group/mi relative flex h-7 cursor-default select-none items-center gap-2 rounded-sm px-2 ' +
  'text-base text-text outline-none transition-quick ' +
  'data-[highlighted]:bg-accent-weak data-[highlighted]:text-text ' +
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50 ' +
  'data-[disabled]:text-text-3';

/** Destructive rows commit to the danger tint only once highlighted. */
export const menuDangerClass =
  'text-danger data-[highlighted]:bg-danger-weak data-[highlighted]:text-danger';

export const menuSeparatorClass = 'my-1 h-px bg-[var(--border)]';

export const menuLabelClass =
  'px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-text-3';

/**
 * The inside of a menu row, shared by {@link Menu} and {@link ContextMenu} so
 * the two can never drift apart.
 *
 * The icon gutter is a fixed-width box that is rendered even when an item has no
 * icon — that is what keeps every label in a mixed menu on the same left edge,
 * which was the single most obvious thing wrong with the old menus.
 */
export function MenuItemBody({
  icon,
  label,
  shortcut,
}: {
  icon?: ReactNode;
  label: string;
  shortcut?: string;
}) {
  return (
    <>
      <span className="flex w-4 flex-none items-center justify-center text-text-2 group-data-[highlighted]/mi:text-current">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <span className="ml-4 flex-none font-mono text-xs tabular-nums text-text-3">
          {shortcut}
        </span>
      ) : null}
    </>
  );
}

/** The check gutter for a checkbox row, aligned with the icon gutter above. */
export function MenuCheckBody({ checked, label }: { checked: boolean; label: string }) {
  return (
    <>
      <span className="flex w-4 flex-none items-center justify-center text-accent">
        {checked ? <Icon name="check" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  );
}

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
          sideOffset={6}
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
    return <DropdownMenu.Separator key={item.id} className={menuSeparatorClass} />;
  }

  if (item.kind === 'label') {
    return (
      <DropdownMenu.Label key={item.id} className={menuLabelClass}>
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
        <MenuCheckBody checked={item.checked} label={item.label} />
      </DropdownMenu.CheckboxItem>
    );
  }

  return (
    <DropdownMenu.Item
      key={item.id}
      disabled={item.disabled}
      onSelect={item.onSelect}
      className={cn(menuItemClass, item.danger && menuDangerClass)}
    >
      <MenuItemBody icon={item.icon} label={item.label} shortcut={item.shortcut} />
    </DropdownMenu.Item>
  );
}
