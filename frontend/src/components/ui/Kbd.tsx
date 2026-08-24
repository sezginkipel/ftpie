import { cn } from '../../lib/cn';

export interface KbdProps {
  /**
   * A shortcut in `Ctrl+Shift+T` form. `Mod` is rendered as the platform's
   * command key, so a shortcut sheet does not have to branch per OS.
   */
  keys: string;
  className?: string;
}

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform ?? '');

const SYMBOLS: Record<string, string> = {
  Mod: IS_MAC ? '⌘' : 'Ctrl',
  Cmd: '⌘',
  Ctrl: IS_MAC ? '⌃' : 'Ctrl',
  Alt: IS_MAC ? '⌥' : 'Alt',
  Shift: IS_MAC ? '⇧' : 'Shift',
  Enter: '↵',
  Escape: 'Esc',
  Space: 'Space',
  Backspace: '⌫',
  Delete: 'Del',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
};

/** Renders a keyboard shortcut as a row of key caps. */
export function Kbd({ keys, className }: KbdProps) {
  const parts = keys.split('+').map((part) => part.trim());

  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {parts.map((part, index) => (
        <kbd
          key={`${part}-${index}`}
          className={cn(
            'inline-flex h-4 min-w-4 items-center justify-center rounded border',
            'border-border-strong bg-surface-2 px-1 font-mono text-2xs text-text-2',
          )}
        >
          {SYMBOLS[part] ?? part}
        </kbd>
      ))}
    </span>
  );
}
