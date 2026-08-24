import { beforeEach, describe, expect, it } from 'vitest';

import { clearInvokeMocks, invokeCalls, mockInvoke } from '../test/setup';
import type { ConnectResult, SessionMeta } from '../lib/types';
import { useSessionStore } from './sessionStore';

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    host: 'example.com',
    port: 22,
    username: 'admin',
    protocol: 'sftp',
    ...overrides,
  };
}

function result(overrides: Partial<SessionMeta> = {}, secure = true): ConnectResult {
  return { session: meta(overrides), secure };
}

const store = () => useSessionStore.getState();

beforeEach(() => {
  clearInvokeMocks();
  useSessionStore.setState({
    sessions: {},
    order: [],
    activeId: null,
    ui: {},
    closing: [],
  });
});

describe('connect', () => {
  it('adopts the session, makes it active and seeds its UI state', async () => {
    mockInvoke('connect', () => result());
    mockInvoke('set_max_concurrent_transfers', () => null);

    await store().connect({ host: 'example.com', username: 'admin', protocol: 'sftp' });

    expect(store().activeId).toBe('s1');
    expect(store().order).toEqual(['s1']);
    expect(store().active()?.host).toBe('example.com');

    const ui = store().uiFor('s1');
    expect(ui?.remotePath).toBe('/');
    expect(ui?.selection).toEqual({ local: [], remote: [] });
    expect(ui?.sort.local).toEqual({ key: 'name', direction: 'asc' });
    expect(ui?.secure).toBe(true);
  });

  it('fills the timeouts from settings when the caller omits them', async () => {
    mockInvoke('connect', () => result());
    await store().connect({ host: 'h', username: 'u', protocol: 'ftp' });

    const args = invokeCalls.at(-1)?.args?.args as Record<string, unknown>;
    expect(args.connectTimeoutSecs).toBe(15);
    expect(args.ioTimeoutSecs).toBe(60);
  });

  it('surfaces untrusted_host to the caller instead of guessing', async () => {
    mockInvoke('connect', () => {
      throw {
        code: 'untrusted_host',
        host: 'example.com',
        port: 22,
        kind: 'ssh_host_key',
        algorithm: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
        previousFingerprint: null,
        message: 'unknown host key',
      };
    });

    await expect(
      store().connect({ host: 'example.com', username: 'admin', protocol: 'sftp' }),
    ).rejects.toMatchObject({ code: 'untrusted_host', fingerprint: 'SHA256:abc' });

    // Nothing half-created.
    expect(store().order).toEqual([]);
    expect(store().activeId).toBeNull();
  });

  it('surfaces vault_locked to the caller', async () => {
    mockInvoke('connect_bookmark', () => {
      throw { code: 'vault_locked', message: 'vault is locked' };
    });
    await expect(store().connectBookmark('b1')).rejects.toMatchObject({
      code: 'vault_locked',
    });
  });

  it('reconnecting the same id preserves where the user was', async () => {
    mockInvoke('connect', () => result());
    await store().connect({ host: 'h', username: 'u', protocol: 'sftp' });
    store().setRemotePath('s1', '/var/www');

    await store().connect({ host: 'h', username: 'u', protocol: 'sftp' });
    expect(store().uiFor('s1')?.remotePath).toBe('/var/www');
  });
});

describe('disconnect', () => {
  it('removes the tab before awaiting the backend', async () => {
    mockInvoke('connect', () => result());
    await store().connect({ host: 'h', username: 'u', protocol: 'sftp' });

    let removedBeforeBackendRan = false;
    mockInvoke('disconnect', () => {
      removedBeforeBackendRan = store().sessions.s1 === undefined;
      return null;
    });

    await store().disconnect('s1');
    expect(removedBeforeBackendRan).toBe(true);
    expect(store().order).toEqual([]);
    expect(store().activeId).toBeNull();
    expect(store().uiFor('s1')).toBeNull();
  });

  it('never leaves a stuck tab when the backend rejects', async () => {
    mockInvoke('connect', () => result());
    await store().connect({ host: 'h', username: 'u', protocol: 'sftp' });

    mockInvoke('disconnect', () => {
      throw { code: 'network', message: 'socket is already dead' };
    });

    // The old store awaited first and rethrew, leaving the tab forever.
    await expect(store().disconnect('s1')).resolves.toBeUndefined();
    expect(store().sessions.s1).toBeUndefined();
    expect(store().closing).toEqual([]);
  });

  it('falls back to the previous tab when the active one closes', async () => {
    mockInvoke('connect', () => result({ id: 's1' }));
    await store().connect({ host: 'a', username: 'u', protocol: 'sftp' });
    mockInvoke('connect', () => result({ id: 's2' }));
    await store().connect({ host: 'b', username: 'u', protocol: 'sftp' });
    mockInvoke('disconnect', () => null);

    expect(store().activeId).toBe('s2');
    await store().disconnect('s2');
    expect(store().activeId).toBe('s1');
  });
});

describe('per-session UI state', () => {
  beforeEach(async () => {
    mockInvoke('connect', () => result({ id: 's1' }));
    await store().connect({ host: 'a', username: 'u', protocol: 'sftp' });
    mockInvoke('connect', () => result({ id: 's2', host: 'b' }));
    await store().connect({ host: 'b', username: 'u', protocol: 'sftp' });
  });

  it('keeps paths independent per session', () => {
    store().setRemotePath('s1', '/var/www');
    store().setRemotePath('s2', '/srv/app');

    // The old code kept one component-level remotePath, so switching tabs
    // queried the new session at the old session's path.
    expect(store().uiFor('s1')?.remotePath).toBe('/var/www');
    expect(store().uiFor('s2')?.remotePath).toBe('/srv/app');
  });

  it('keeps selections independent and does not leak across sessions', () => {
    store().setSelection('s1', 'remote', ['/a.txt']);
    expect(store().uiFor('s2')?.selection.remote).toEqual([]);
  });

  it('clears the pane’s selection on navigation', () => {
    store().setSelection('s1', 'remote', ['/a.txt', '/b.txt']);
    store().setSelection('s1', 'local', ['C:\\x.txt']);

    store().setRemotePath('s1', '/elsewhere');
    expect(store().uiFor('s1')?.selection.remote).toEqual([]);
    // The other pane is untouched.
    expect(store().uiFor('s1')?.selection.local).toEqual(['C:\\x.txt']);
  });

  it('keeps sort state per pane per session', () => {
    store().setSort('s1', 'remote', { key: 'size', direction: 'desc' });
    expect(store().uiFor('s1')?.sort.remote).toEqual({ key: 'size', direction: 'desc' });
    expect(store().uiFor('s1')?.sort.local).toEqual({ key: 'name', direction: 'asc' });
    expect(store().uiFor('s2')?.sort.remote).toEqual({ key: 'name', direction: 'asc' });
  });

  it('ignores UI updates for an unknown session', () => {
    store().setRemotePath('ghost', '/nowhere');
    expect(store().uiFor('ghost')).toBeNull();
  });

  it('refuses to activate a session that does not exist', () => {
    store().setActive('ghost');
    expect(store().activeId).toBe('s2');
  });
});

describe('hydrate', () => {
  it('reconciles with list_sessions and keeps existing UI state', async () => {
    mockInvoke('connect', () => result({ id: 's1' }));
    await store().connect({ host: 'a', username: 'u', protocol: 'sftp' });
    store().setRemotePath('s1', '/kept');

    mockInvoke('list_sessions', () => [meta({ id: 's1' }), meta({ id: 's9', host: 'z' })]);
    await store().hydrate();

    expect(store().order).toEqual(['s1', 's9']);
    expect(store().uiFor('s1')?.remotePath).toBe('/kept');
    expect(store().uiFor('s9')?.remotePath).toBe('/');
  });

  it('drops sessions the backend no longer knows about', async () => {
    mockInvoke('connect', () => result({ id: 's1' }));
    await store().connect({ host: 'a', username: 'u', protocol: 'sftp' });

    mockInvoke('list_sessions', () => []);
    await store().hydrate();

    expect(store().order).toEqual([]);
    expect(store().activeId).toBeNull();
  });
});
