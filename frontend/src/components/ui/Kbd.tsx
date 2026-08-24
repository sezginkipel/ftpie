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

/**
 * Renders a keyboard shortcut as a row of key caps.
 *
 * The cap is built from three things a real key has: a border a shade stronger
 * than the surface, a soft top-inset highlight, and a 1px bottom shadow that
 * reads as the key standing off the page. Flat bordered boxes read as code
 * spans, not keys.
 */
export function Kbd({ keys, className }: KbdProps) {
  const parts = keys.split('+').map((part) => part.trim());

  return (
    <span className={cn('inline-flex flex-none items-center gap-1', className)}>
      {parts.map((part, index) => (
        <kbd
          key={`${part}-${index}`}
          className={cn(
            'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm',
            'border border-border-strong bg-surface-2 px-1.5',
            'font-mono text-2xs font-medium leading-none text-text-2',
            'shadow-[inset_0_1px_0_0_var(--highlight),0_1px_0_0_var(--border-strong)]',
          )}
        >
          {SYMBOLS[part] ?? part}
        </kbd>
      ))}
    </span>
  );
}
