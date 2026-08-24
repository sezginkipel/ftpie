import { describe, expect, it } from 'vitest';

import {
  isTypeAheadKey,
  mapGlobalKey,
  mapPaneKey,
  PAGE_ROWS,
  type KeyLike,
} from './keyboard';

function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...partial };
}

describe('mapPaneKey', () => {
  it('moves the cursor with the arrows', () => {
    expect(mapPaneKey(key({ key: 'ArrowDown' }))).toEqual({
      kind: 'move',
      delta: 1,
      extend: false,
    });
    expect(mapPaneKey(key({ key: 'ArrowUp' }))).toEqual({
      kind: 'move',
      delta: -1,
      extend: false,
    });
  });

  it('extends the selection when Shift is held', () => {
    expect(mapPaneKey(key({ key: 'ArrowDown', shiftKey: true }))).toEqual({
      kind: 'move',
      delta: 1,
      extend: true,
    });
  });

  it('pages by a viewport and jumps to the ends', () => {
    expect(mapPaneKey(key({ key: 'PageDown' }))).toEqual({
      kind: 'move',
      delta: PAGE_ROWS,
      extend: false,
    });
    expect(mapPaneKey(key({ key: 'Home', shiftKey: true }))).toEqual({
      kind: 'moveTo',
      position: 'first',
      extend: true,
    });
    expect(mapPaneKey(key({ key: 'End' }))).toEqual({
      kind: 'moveTo',
      position: 'last',
      extend: false,
    });
  });

  it('maps the direct-action keys', () => {
    expect(mapPaneKey(key({ key: ' ' }))).toEqual({ kind: 'toggle' });
    expect(mapPaneKey(key({ key: 'Enter' }))).toEqual({ kind: 'open' });
    expect(mapPaneKey(key({ key: 'Backspace' }))).toEqual({ kind: 'up' });
    expect(mapPaneKey(key({ key: 'Delete' }))).toEqual({ kind: 'delete' });
    expect(mapPaneKey(key({ key: 'F2' }))).toEqual({ kind: 'rename' });
    expect(mapPaneKey(key({ key: 'F5' }))).toEqual({ kind: 'refresh' });
    expect(mapPaneKey(key({ key: 'F7' }))).toEqual({ kind: 'newFolder' });
    expect(mapPaneKey(key({ key: 'Escape' }))).toEqual({ kind: 'clearSelection' });
  });

  it('accepts either Ctrl or Cmd for select-all, copy and paste', () => {
    expect(mapPaneKey(key({ key: 'a', ctrlKey: true }))).toEqual({ kind: 'selectAll' });
    expect(mapPaneKey(key({ key: 'A', metaKey: true }))).toEqual({ kind: 'selectAll' });
    expect(mapPaneKey(key({ key: 'c', ctrlKey: true }))).toEqual({ kind: 'copy' });
    expect(mapPaneKey(key({ key: 'V', ctrlKey: true }))).toEqual({ kind: 'paste' });
  });

  it('puts the cross-pane transfer on Ctrl+Enter, not on Enter', () => {
    expect(mapPaneKey(key({ key: 'Enter', ctrlKey: true }))).toEqual({ kind: 'transfer' });
    expect(mapPaneKey(key({ key: 'Enter' }))).toEqual({ kind: 'open' });
  });

  it('switches panes on Tab but leaves Shift+Tab to the browser', () => {
    expect(mapPaneKey(key({ key: 'Tab' }))).toEqual({ kind: 'switchPane' });
    expect(mapPaneKey(key({ key: 'Tab', shiftKey: true }))).toBeNull();
  });

  it('feeds a bare printable character to type-ahead', () => {
    expect(mapPaneKey(key({ key: 'r' }))).toEqual({ kind: 'typeAhead', char: 'r' });
    expect(mapPaneKey(key({ key: '.' }))).toEqual({ kind: 'typeAhead', char: '.' });
  });

  it('does not treat a modified character as type-ahead', () => {
    expect(isTypeAheadKey(key({ key: 'z', ctrlKey: true }))).toBe(false);
    expect(isTypeAheadKey(key({ key: 'z', altKey: true }))).toBe(false);
    expect(isTypeAheadKey(key({ key: 'z' }))).toBe(true);
    // Space is a selection toggle, never type-ahead.
    expect(isTypeAheadKey(key({ key: ' ' }))).toBe(false);
  });

  it('ignores keys the pane does not own', () => {
    expect(mapPaneKey(key({ key: 'F12' }))).toBeNull();
    expect(mapPaneKey(key({ key: 'ArrowLeft', altKey: true }))).toBeNull();
  });
});

describe('mapGlobalKey', () => {
  it('maps the documented global shortcuts', () => {
    expect(mapGlobalKey(key({ key: 'n', ctrlKey: true }))).toEqual({
      kind: 'newConnection',
    });
    expect(mapGlobalKey(key({ key: ',', ctrlKey: true }))).toEqual({ kind: 'settings' });
    expect(mapGlobalKey(key({ key: 'q', ctrlKey: true }))).toEqual({ kind: 'quit' });
    expect(mapGlobalKey(key({ key: 'F5' }))).toEqual({ kind: 'refresh' });
    expect(mapGlobalKey(key({ key: 'T', ctrlKey: true, shiftKey: true }))).toEqual({
      kind: 'closeSession',
    });
    expect(mapGlobalKey(key({ key: '?' }))).toEqual({ kind: 'shortcuts' });
  });

  it('maps the panel toggles exactly as the shortcut sheet documents them', () => {
    expect(mapGlobalKey(key({ key: 'b', ctrlKey: true }))).toEqual({
      kind: 'togglePanel',
      panel: 'sidebar',
    });
    expect(mapGlobalKey(key({ key: 'j', ctrlKey: true }))).toEqual({
      kind: 'togglePanel',
      panel: 'transfers',
    });
    expect(mapGlobalKey(key({ key: 'E', metaKey: true }))).toEqual({
      kind: 'togglePanel',
      panel: 'editor',
    });
    expect(mapGlobalKey(key({ key: 'g', ctrlKey: true }))).toEqual({
      kind: 'togglePanel',
      panel: 'git',
    });
    expect(mapGlobalKey(key({ key: 'i', ctrlKey: true }))).toEqual({
      kind: 'togglePanel',
      panel: 'ai',
    });
  });

  it('does not claim a plain letter or Tab', () => {
    expect(mapGlobalKey(key({ key: 'n' }))).toBeNull();
    expect(mapGlobalKey(key({ key: 'Tab' }))).toBeNull();
  });
});
