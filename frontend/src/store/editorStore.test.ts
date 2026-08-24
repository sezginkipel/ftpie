import { beforeEach, describe, expect, it } from 'vitest';

import { clearInvokeMocks, invokeCalls, mockInvoke } from '../test/setup';
import type { OpenedFile } from '../lib/types';
import { isReopenConflict, useEditorStore } from './editorStore';

function opened(overrides: Partial<OpenedFile> = {}): OpenedFile {
  return {
    content: 'hello\n',
    isBinary: false,
    hash: 'hash-1',
    size: 6,
    encoding: 'utf-8',
    ...overrides,
  };
}

const store = () => useEditorStore.getState();

beforeEach(() => {
  clearInvokeMocks();
  useEditorStore.setState({ tabs: [], activeId: null });
});

describe('open', () => {
  it('creates a clean tab keyed by session and path', async () => {
    mockInvoke('editor_open_file', () => opened());
    const tab = await store().open('s1', '/var/www/index.html');

    expect(tab.id).toBe('s1:/var/www/index.html');
    expect(tab.fileName).toBe('index.html');
    expect(tab.dirty).toBe(false);
    expect(tab.originalHash).toBe('hash-1');
    expect(store().activeId).toBe(tab.id);
  });

  it('refreshes a clean tab rather than discarding the fetched content', async () => {
    mockInvoke('editor_open_file', () => opened());
    await store().open('s1', '/a.txt');

    mockInvoke('editor_open_file', () => opened({ content: 'newer\n', hash: 'hash-2' }));
    const reopened = await store().open('s1', '/a.txt');

    expect(reopened.content).toBe('newer\n');
    expect(reopened.originalHash).toBe('hash-2');
    expect(store().tabs).toHaveLength(1);
  });

  it('reports a conflict instead of silently overwriting unsaved edits', async () => {
    mockInvoke('editor_open_file', () => opened());
    await store().open('s1', '/a.txt');
    store().setContent('s1:/a.txt', 'my local edits\n');

    mockInvoke('editor_open_file', () => opened({ content: 'server\n', hash: 'hash-2' }));
    const rejection = await store().open('s1', '/a.txt').catch((e: unknown) => e);

    expect(isReopenConflict(rejection)).toBe(true);
    // Both versions are still available: the buffer, and the fetched copy.
    expect(store().byId('s1:/a.txt')?.content).toBe('my local edits\n');
    if (isReopenConflict(rejection)) {
      expect(rejection.fetched.content).toBe('server\n');
    }
  });

  it('keeps the same file open per session separately', async () => {
    mockInvoke('editor_open_file', () => opened());
    await store().open('s1', '/a.txt');
    await store().open('s2', '/a.txt');
    expect(store().tabs.map((t) => t.id)).toEqual(['s1:/a.txt', 's2:/a.txt']);
  });
});

describe('binary files are read-only', () => {
  it('refuses to accept edits to a binary buffer', async () => {
    mockInvoke('editor_open_file', () => opened({ isBinary: true, content: 'UEsDBA==' }));
    await store().open('s1', '/a.zip');

    store().setContent('s1:/a.zip', 'corrupted');
    const tab = store().byId('s1:/a.zip');
    expect(tab?.content).toBe('UEsDBA==');
    expect(tab?.dirty).toBe(false);
  });

  it('refuses to save a binary tab at all', async () => {
    mockInvoke('editor_open_file', () => opened({ isBinary: true }));
    await store().open('s1', '/a.zip');

    // The old editor round-tripped base64 through a text buffer and wrote it
    // back, corrupting the file.
    await expect(store().save('s1:/a.zip')).rejects.toMatchObject({ code: 'config' });
    expect(invokeCalls.some((c) => c.cmd === 'editor_save_file')).toBe(false);
  });
});

describe('save', () => {
  beforeEach(async () => {
    mockInvoke('editor_open_file', () => opened());
    await store().open('s1', '/a.txt');
    store().setContent('s1:/a.txt', 'edited\n');
  });

  it('sends expectedHash for optimistic concurrency', async () => {
    mockInvoke('editor_save_file', (args) => {
      const payload = args.args as Record<string, unknown>;
      expect(payload.expectedHash).toBe('hash-1');
      expect(payload.content).toBe('edited\n');
      expect(payload.isBinary).toBe(false);
      return { hash: 'hash-2', bytes: 7 };
    });

    await store().save('s1:/a.txt');
    const tab = store().byId('s1:/a.txt');
    expect(tab?.dirty).toBe(false);
    expect(tab?.originalHash).toBe('hash-2');
    expect(tab?.saving).toBe(false);
    expect(tab?.saveError).toBeNull();
  });

  it('omits expectedHash when the user explicitly chose to overwrite', async () => {
    mockInvoke('editor_save_file', (args) => {
      expect((args.args as Record<string, unknown>).expectedHash).toBeNull();
      return { hash: 'hash-2', bytes: 7 };
    });
    await store().save('s1:/a.txt', { force: true });
  });

  it('keeps the tab dirty and records the error when the save fails', async () => {
    mockInvoke('editor_save_file', () => {
      throw { code: 'permission', message: 'read-only filesystem' };
    });

    // Save failures used to be console.error only — invisible to the user.
    await expect(store().save('s1:/a.txt')).rejects.toMatchObject({
      code: 'permission',
    });
    const tab = store().byId('s1:/a.txt');
    expect(tab?.dirty).toBe(true);
    expect(tab?.saving).toBe(false);
    expect(tab?.saveError).toMatchObject({ code: 'permission' });
  });

  it('re-throws a conflict so the save-conflict dialog can open', async () => {
    mockInvoke('editor_save_file', () => {
      throw { code: 'conflict', message: 'changed', remoteHash: 'server-hash' };
    });
    await expect(store().save('s1:/a.txt')).rejects.toMatchObject({
      code: 'conflict',
      remoteHash: 'server-hash',
    });
    expect(store().byId('s1:/a.txt')?.dirty).toBe(true);
  });
});

describe('tab lifecycle', () => {
  beforeEach(async () => {
    mockInvoke('editor_open_file', () => opened());
    await store().open('s1', '/a.txt');
    await store().open('s1', '/b.txt');
    await store().open('s2', '/c.txt');
  });

  it('tracks dirty tabs for the quit guard', () => {
    store().setContent('s1:/a.txt', 'x');
    expect(store().dirtyTabs().map((t) => t.id)).toEqual(['s1:/a.txt']);
  });

  it('closing a session closes exactly its tabs', () => {
    store().closeSession('s1');
    expect(store().tabs.map((t) => t.id)).toEqual(['s2:/c.txt']);
    expect(store().activeId).toBe('s2:/c.txt');
  });

  it('falls back to the previous tab when the active one closes', () => {
    store().setActive('s1:/b.txt');
    store().close('s1:/b.txt');
    expect(store().activeId).toBe('s2:/c.txt');
  });

  it('clears activeId when the last tab closes', () => {
    for (const id of ['s1:/a.txt', 's1:/b.txt', 's2:/c.txt']) store().close(id);
    expect(store().tabs).toEqual([]);
    expect(store().activeId).toBeNull();
  });

  it('applyFetched discards local edits and resets the hash', () => {
    store().setContent('s1:/a.txt', 'edited');
    store().applyFetched('s1:/a.txt', opened({ content: 'server', hash: 'hash-9' }));

    const tab = store().byId('s1:/a.txt');
    expect(tab?.content).toBe('server');
    expect(tab?.originalHash).toBe('hash-9');
    expect(tab?.dirty).toBe(false);
  });
});
