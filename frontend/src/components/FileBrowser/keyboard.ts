/**
 * The file pane's keyboard map, as a pure function.
 *
 * Keeping the mapping out of the event handler means every binding is unit
 * tested and the handler itself is a `switch` over intent. The old panes had no
 * keyboard support at all — rows were clickable `<div>`s.
 */

/** Just enough of a `KeyboardEvent` to decide what was pressed. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type PaneAction =
  /** Move the cursor by `delta` rows, extending the selection when `extend`. */
  | { kind: 'move'; delta: number; extend: boolean }
  | { kind: 'moveTo'; position: 'first' | 'last'; extend: boolean }
  | { kind: 'selectAll' }
  | { kind: 'clearSelection' }
  /** Space: add or remove the cursor row from the selection. */
  | { kind: 'toggle' }
  /** Enter / double click: folder → navigate, file → the configured action. */
  | { kind: 'open' }
  | { kind: 'up' }
  | { kind: 'delete' }
  | { kind: 'rename' }
  | { kind: 'newFolder' }
  | { kind: 'refresh' }
  /** Ctrl+C — remember the selection for a later paste, and copy the paths. */
  | { kind: 'copy' }
  /** Ctrl+V — transfer whatever Ctrl+C recorded into this pane. */
  | { kind: 'paste' }
  /** The default transfer to the opposite pane. */
  | { kind: 'transfer' }
  /** Tab: hand focus to the other pane, as a dual-pane file manager does. */
  | { kind: 'switchPane' }
  | { kind: 'typeAhead'; char: string };

/** How many rows Page Up / Page Down move. Matches a typical viewport. */
export const PAGE_ROWS = 12;

function isModified(event: KeyLike): boolean {
  return event.ctrlKey || event.metaKey || event.altKey;
}

/** True for a single character that should feed type-ahead. */
export function isTypeAheadKey(event: KeyLike): boolean {
  return !isModified(event) && event.key.length === 1 && event.key !== ' ';
}

/**
 * Translate a key press into a pane action, or `null` when the pane should not
 * handle it (so the browser keeps Tab, F-keys we do not own, and so on).
 */
export function mapPaneKey(event: KeyLike): PaneAction | null {
  const mod = event.ctrlKey || event.metaKey;

  // Checked before the plain-key switch, so Ctrl+Enter is not swallowed by
  // "Enter opens". Documented in `ShortcutSheet`'s SHORTCUT_GROUPS as Mod+Enter.
  if (mod && event.key === 'Enter') return { kind: 'transfer' };

  switch (event.key) {
    case 'ArrowDown':
      return { kind: 'move', delta: 1, extend: event.shiftKey };
    case 'ArrowUp':
      return { kind: 'move', delta: -1, extend: event.shiftKey };
    case 'PageDown':
      return { kind: 'move', delta: PAGE_ROWS, extend: event.shiftKey };
    case 'PageUp':
      return { kind: 'move', delta: -PAGE_ROWS, extend: event.shiftKey };
    case 'Home':
      return { kind: 'moveTo', position: 'first', extend: event.shiftKey };
    case 'End':
      return { kind: 'moveTo', position: 'last', extend: event.shiftKey };
    case ' ':
      return { kind: 'toggle' };
    case 'Enter':
      return { kind: 'open' };
    case 'Backspace':
      return { kind: 'up' };
    case 'Delete':
      return { kind: 'delete' };
    case 'Escape':
      return { kind: 'clearSelection' };
    case 'F2':
      return { kind: 'rename' };
    case 'F5':
      return { kind: 'refresh' };
    case 'F7':
      return { kind: 'newFolder' };
    case 'Tab':
      // Shift+Tab is left to the browser so the pane is never a keyboard trap.
      return event.shiftKey || isModified(event) ? null : { kind: 'switchPane' };
    default:
      break;
  }

  if (mod && !event.altKey) {
    const lower = event.key.toLowerCase();
    if (lower === 'a') return { kind: 'selectAll' };
    if (lower === 'c') return { kind: 'copy' };
    if (lower === 'v') return { kind: 'paste' };
    if (lower === 'r') return { kind: 'refresh' };
  }

  if (isTypeAheadKey(event)) return { kind: 'typeAhead', char: event.key };
  return null;
}

/**
 * Window-level shortcuts App registers.
 *
 * These mirror `SHORTCUT_GROUPS` in `ShortcutSheet.tsx`, which is the
 * user-facing contract — if the two ever disagree, the sheet is right and this
 * map is the bug.
 */
export type GlobalAction =
  | { kind: 'newConnection' }
  | { kind: 'settings' }
  | { kind: 'quit' }
  | { kind: 'refresh' }
  | { kind: 'closeSession' }
  | { kind: 'shortcuts' }
  | { kind: 'togglePanel'; panel: 'sidebar' | 'transfers' | 'editor' | 'git' | 'ai' };

const PANEL_KEYS: Record<string, GlobalAction & { kind: 'togglePanel' }> = {
  b: { kind: 'togglePanel', panel: 'sidebar' },
  j: { kind: 'togglePanel', panel: 'transfers' },
  e: { kind: 'togglePanel', panel: 'editor' },
  g: { kind: 'togglePanel', panel: 'git' },
  i: { kind: 'togglePanel', panel: 'ai' },
};

export function mapGlobalKey(event: KeyLike): GlobalAction | null {
  const mod = event.ctrlKey || event.metaKey;

  if (event.key === 'F5') return { kind: 'refresh' };

  if (mod && event.shiftKey && event.key.toLowerCase() === 't') {
    return { kind: 'closeSession' };
  }

  if (mod && !event.shiftKey && !event.altKey) {
    const lower = event.key.toLowerCase();
    if (lower === 'n') return { kind: 'newConnection' };
    if (lower === 'q') return { kind: 'quit' };
    if (event.key === ',') return { kind: 'settings' };
    const panel = PANEL_KEYS[lower];
    if (panel) return panel;
  }

  if (!mod && !event.altKey && event.key === '?') return { kind: 'shortcuts' };
  return null;
}
