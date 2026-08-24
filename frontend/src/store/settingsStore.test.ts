import { beforeEach, describe, expect, it } from 'vitest';

import { clearInvokeMocks, invokeCalls, mockInvoke } from '../test/setup';
import { DEFAULT_SETTINGS, useSettingsStore } from './settingsStore';

const store = () => useSettingsStore.getState();

beforeEach(() => {
  clearInvokeMocks();
  mockInvoke('set_max_concurrent_transfers', () => null);
  useSettingsStore.setState({ ...DEFAULT_SETTINGS });
});

describe('defaults', () => {
  it('defaults the interface to English and the theme to the system', () => {
    expect(DEFAULT_SETTINGS.locale).toBe('en');
    expect(DEFAULT_SETTINGS.theme).toBe('system');
  });

  it('defaults the overwrite mode to ask, which the UI must actually honour', () => {
    expect(DEFAULT_SETTINGS.overwriteMode).toBe('ask');
  });
});

describe('set', () => {
  it('clamps numeric settings to the ranges the backend enforces', () => {
    store().set({ maxConcurrentTransfers: 99 });
    expect(store().maxConcurrentTransfers).toBe(16);

    store().set({ maxConcurrentTransfers: 0 });
    expect(store().maxConcurrentTransfers).toBe(1);

    store().set({ connectTimeoutSecs: 10_000 });
    expect(store().connectTimeoutSecs).toBe(300);

    store().set({ ioTimeoutSecs: 0 });
    expect(store().ioTimeoutSecs).toBe(1);

    store().set({ editorTabSize: 40 });
    expect(store().editorTabSize).toBe(8);

    store().set({ editorFontSize: 2 });
    expect(store().editorFontSize).toBe(9);
  });

  it('falls back to the default for a non-numeric value', () => {
    store().set({ maxConcurrentTransfers: Number.NaN });
    expect(store().maxConcurrentTransfers).toBe(DEFAULT_SETTINGS.maxConcurrentTransfers);
  });

  it('pushes maxConcurrentTransfers to the backend', async () => {
    store().set({ maxConcurrentTransfers: 5 });
    // The push is deliberately not awaited by `set`; give the microtask a turn.
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeCalls).toContainEqual({
      cmd: 'set_max_concurrent_transfers',
      args: { count: 5 },
    });
  });

  it('does not call the backend for unrelated settings', async () => {
    store().set({ showHiddenFiles: true });
    await Promise.resolve();
    expect(invokeCalls).toEqual([]);
    expect(store().showHiddenFiles).toBe(true);
  });

  it('leaves unrelated settings alone', () => {
    store().set({ locale: 'en' });
    expect(store().locale).toBe('en');
    expect(store().theme).toBe(DEFAULT_SETTINGS.theme);
  });
});

describe('syncToBackend', () => {
  it('sends the current concurrency', async () => {
    store().set({ maxConcurrentTransfers: 7 });
    clearInvokeMocks();
    mockInvoke('set_max_concurrent_transfers', () => null);

    await store().syncToBackend();
    expect(invokeCalls).toEqual([{ cmd: 'set_max_concurrent_transfers', args: { count: 7 } }]);
  });

  it('propagates a rejection so the caller can toast it', async () => {
    clearInvokeMocks();
    await expect(store().syncToBackend()).rejects.toBeTruthy();
  });
});

describe('reset', () => {
  it('restores every default', () => {
    store().set({ locale: 'en', showHiddenFiles: true, maxConcurrentTransfers: 9 });
    store().reset();

    expect(store().locale).toBe('en');
    expect(store().showHiddenFiles).toBe(false);
    expect(store().maxConcurrentTransfers).toBe(DEFAULT_SETTINGS.maxConcurrentTransfers);
  });
});

describe('every setting has an owner', () => {
  it('carries no fields beyond the documented set', () => {
    // Guards the rule that a setting nobody honours must not exist. Adding one
    // here without wiring it up will fail this test.
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(
      [
        'confirmDelete',
        'connectTimeoutSecs',
        'dateFormat',
        'defaultProtocol',
        'doubleClickAction',
        'editorFontSize',
        'editorTabSize',
        'editorWordWrap',
        'ioTimeoutSecs',
        'locale',
        'maxConcurrentTransfers',
        'overwriteMode',
        'showHiddenFiles',
        'theme',
      ].sort(),
    );
    // `transferMode` was never wired to anything and is gone.
    expect(DEFAULT_SETTINGS).not.toHaveProperty('transferMode');
  });
});
