import { beforeEach, describe, expect, it } from 'vitest';

import { clearInvokeMocks, invokeCalls, mockInvoke } from '../test/setup';
import type { Bookmark } from '../lib/types';
import { hasStoredPassword } from '../lib/types';
import { canStorePassword, useBookmarkStore } from './bookmarkStore';

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: 'b1',
    name: 'Production',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    protocol: 'sftp',
    remotePath: '/var/www',
    localPath: null,
    privateKeyPath: null,
    passiveMode: null,
    tags: ['prod'],
    createdAt: '2026-01-01T00:00:00Z',
    hasPassword: false,
    ...overrides,
  };
}

const store = () => useBookmarkStore.getState();

beforeEach(() => {
  clearInvokeMocks();
  useBookmarkStore.setState({ bookmarks: [], loading: false, error: null });
});

describe('the empty-master-password path is gone', () => {
  it('never sends a masterPassword field when creating with a password', async () => {
    mockInvoke('create_bookmark', (args) => {
      const input = args.input as Record<string, unknown>;
      // The old store sent `master_password: args.password ? (args.masterPassword ?? "")
      // : null`, deriving the encryption key from "" for every stored credential.
      expect(input).not.toHaveProperty('masterPassword');
      expect(input).not.toHaveProperty('master_password');
      expect(input.password).toBe('s3cret');
      return bookmark();
    });

    await store().create({
      name: 'Production',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      protocol: 'sftp',
      password: 's3cret',
    });
    expect(invokeCalls.at(-1)?.cmd).toBe('create_bookmark');
  });

  it('lets a locked vault reject the save rather than falling back', async () => {
    mockInvoke('create_bookmark', () => {
      throw { code: 'vault_locked', message: 'vault is locked' };
    });

    await expect(
      store().create({
        name: 'x',
        host: 'h',
        port: 22,
        username: 'u',
        protocol: 'sftp',
        password: 'p',
      }),
    ).rejects.toMatchObject({ code: 'vault_locked' });
    expect(store().bookmarks).toEqual([]);
  });

  it('canStorePassword requires an initialized AND unlocked vault', () => {
    expect(canStorePassword(null)).toBe(false);
    expect(canStorePassword({ initialized: false, unlocked: false })).toBe(false);
    expect(canStorePassword({ initialized: true, unlocked: false })).toBe(false);
    expect(canStorePassword({ initialized: true, unlocked: true })).toBe(true);
  });
});

describe('update', () => {
  it('calls update_bookmark, never delete-then-create', async () => {
    useBookmarkStore.setState({ bookmarks: [bookmark()] });
    mockInvoke('update_bookmark', (args) => {
      const update = args.update as Record<string, unknown>;
      expect(update.id).toBe('b1');
      return bookmark({ name: 'Renamed' });
    });

    await store().update({
      id: 'b1',
      name: 'Renamed',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      protocol: 'sftp',
    });

    // A failed create used to lose the bookmark entirely.
    expect(invokeCalls.map((c) => c.cmd)).toEqual(['update_bookmark']);
    expect(store().bookmarks).toHaveLength(1);
    expect(store().bookmarks[0].name).toBe('Renamed');
  });

  it('never sends credential material back to the backend', async () => {
    const withSecret = bookmark({ hasPassword: true });
    useBookmarkStore.setState({ bookmarks: [withSecret] });
    mockInvoke('update_bookmark', (args) => {
      // `encryptedPassword` no longer exists on the wire at all, and the
      // derived flag is read-only: neither may be sent.
      expect(args.update).not.toHaveProperty('encryptedPassword');
      expect(args.update).not.toHaveProperty('hasPassword');
      return withSecret;
    });

    await store().update({
      id: 'b1',
      name: 'Production',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      protocol: 'sftp',
    });
  });
});

describe('duplicate', () => {
  it('copies the connection details but not the stored secret', async () => {
    useBookmarkStore.setState({ bookmarks: [bookmark({ hasPassword: true })] });
    mockInvoke('create_bookmark', (args) => {
      const input = args.input as Record<string, unknown>;
      expect(input.host).toBe('example.com');
      expect(input.tags).toEqual(['prod']);
      // The frontend cannot re-encrypt, and it is not handed the ciphertext to
      // copy in the first place.
      expect(input.password).toBeUndefined();
      expect(input).not.toHaveProperty('hasPassword');
      return bookmark({ id: 'b2', name: 'Copy' });
    });

    const copy = await store().duplicate('b1', 'Copy');
    expect(copy.id).toBe('b2');
  });

  it('rejects with not_found for an unknown id', async () => {
    await expect(store().duplicate('ghost', 'x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('reads', () => {
  beforeEach(() => {
    useBookmarkStore.setState({
      bookmarks: [
        bookmark({ id: 'a', name: 'Zeta', tags: ['prod'] }),
        bookmark({ id: 'b', name: 'Alpha', tags: ['prod', 'eu'], host: 'eu.example.com' }),
        bookmark({ id: 'c', name: 'Loose', tags: [] }),
      ],
    });
  });

  it('groups by tag, sorts within a group, and puts untagged last', () => {
    const groups = store().byTag();
    expect(groups.map((g) => g.tag)).toEqual(['eu', 'prod', '']);
    expect(groups[1].bookmarks.map((b) => b.name)).toEqual(['Alpha', 'Zeta']);
  });

  it('searches name, host, username and tags case-insensitively', () => {
    expect(
      store()
        .search('alpha')
        .map((b) => b.id),
    ).toEqual(['b']);
    expect(
      store()
        .search('EU.EXAMPLE')
        .map((b) => b.id),
    ).toEqual(['b']);
    expect(store().search('deploy')).toHaveLength(3);
    expect(store().search('  ')).toHaveLength(3);
    expect(store().search('nothing')).toEqual([]);
  });

  it('detects a stored password from the derived flag alone', () => {
    expect(hasStoredPassword(bookmark())).toBe(false);
    expect(hasStoredPassword(bookmark({ hasPassword: false }))).toBe(false);
    expect(hasStoredPassword(bookmark({ hasPassword: true }))).toBe(true);
  });

  it('is never handed credential material to begin with', async () => {
    // What `list_bookmarks` returns is the whole of what the renderer knows.
    mockInvoke('list_bookmarks', () => [bookmark({ hasPassword: true })]);
    await store().load();

    const [loaded] = store().bookmarks;
    expect(hasStoredPassword(loaded)).toBe(true);
    expect(JSON.stringify(loaded)).not.toContain('ciphertext');
    expect(loaded).not.toHaveProperty('encryptedPassword');
  });
});

describe('load', () => {
  it('records the error and keeps the previous list rather than blanking it', async () => {
    useBookmarkStore.setState({ bookmarks: [bookmark()] });
    await expect(store().load()).rejects.toBeTruthy();

    expect(store().bookmarks).toHaveLength(1);
    expect(store().error).toBeTruthy();
    expect(store().loading).toBe(false);
  });
});
