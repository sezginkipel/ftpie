import { describe, expect, it, beforeEach } from 'vitest';

import { parentPath } from '../../lib/format';
import type { LocalFile, RemoteFile, SortState } from '../../lib/types';
import {
  buildEnqueueItems,
  compareEntries,
  countEntries,
  filterEntries,
  findConflicts,
  fromLocalFile,
  fromRemoteFile,
  getPathClipboard,
  isCaseInsensitiveSide,
  isHiddenName,
  listingQueryKey,
  moveIndex,
  nextSort,
  parseDrag,
  policyForMode,
  rangeBetween,
  selectOnClick,
  selectOnMove,
  serializeDrag,
  setPathClipboard,
  sortEntries,
  typeAheadIndex,
  type PaneEntry,
} from './logic';

// ── Fixtures ────────────────────────────────────────────────────────────────

function entry(partial: Partial<PaneEntry> & { name: string }): PaneEntry {
  return {
    path: `/srv/${partial.name}`,
    isDir: false,
    isSymlink: false,
    symlinkTarget: null,
    size: 0,
    modified: null,
    permissions: null,
    mode: null,
    owner: null,
    group: null,
    hidden: isHiddenName(partial.name),
    readonly: false,
    ...partial,
  };
}

const ASC: SortState = { key: 'name', direction: 'asc' };
const DESC: SortState = { key: 'name', direction: 'desc' };

// ── Normalisation ───────────────────────────────────────────────────────────

describe('normalisation', () => {
  it('maps a RemoteFile, deriving hidden from the dotfile convention', () => {
    const remote: RemoteFile = {
      name: '.env',
      path: '/srv/.env',
      size: 42,
      isDir: false,
      isSymlink: false,
      symlinkTarget: null,
      permissions: 'rw-r--r--',
      mode: 0o644,
      modified: '2026-08-01T10:00:00Z',
      owner: 'root',
      group: 'root',
    };
    const mapped = fromRemoteFile(remote);
    expect(mapped.hidden).toBe(true);
    expect(mapped.permissions).toBe('rw-r--r--');
    expect(mapped.readonly).toBe(false);
  });

  it('trusts the local hidden flag even for a name without a dot', () => {
    const local: LocalFile = {
      name: 'System Volume Information',
      path: 'C:\\System Volume Information',
      size: 0,
      isDir: true,
      isSymlink: false,
      isHidden: true,
      readonly: true,
      modified: null,
    };
    const mapped = fromLocalFile(local);
    expect(mapped.hidden).toBe(true);
    expect(mapped.readonly).toBe(true);
    expect(mapped.permissions).toBeNull();
  });
});

// ── Sorting ─────────────────────────────────────────────────────────────────

describe('compareEntries', () => {
  const dir = entry({ name: 'zzz', isDir: true });
  const file = entry({ name: 'aaa' });

  it('keeps folders first in ascending order', () => {
    expect(compareEntries(dir, file, ASC)).toBeLessThan(0);
  });

  it('keeps folders first in descending order too', () => {
    // Grouping is navigation, not a sort key — reversing must not scatter it.
    expect(compareEntries(dir, file, DESC)).toBeLessThan(0);
  });

  it('sorts names naturally, so file10 comes after file9', () => {
    const sorted = sortEntries(
      [entry({ name: 'file10' }), entry({ name: 'file9' }), entry({ name: 'file1' })],
      ASC,
    ).map((e) => e.name);
    expect(sorted).toEqual(['file1', 'file9', 'file10']);
  });

  it('sorts by size numerically', () => {
    const sorted = sortEntries(
      [
        entry({ name: 'big', size: 5000 }),
        entry({ name: 'small', size: 10 }),
        entry({ name: 'mid', size: 900 }),
      ],
      { key: 'size', direction: 'asc' },
    ).map((e) => e.name);
    expect(sorted).toEqual(['small', 'mid', 'big']);
  });

  it('treats an unknown modified date as the oldest rather than throwing', () => {
    const sorted = sortEntries(
      [
        entry({ name: 'known', modified: '2026-01-01T00:00:00Z' }),
        entry({ name: 'unknown', modified: null }),
      ],
      { key: 'modified', direction: 'asc' },
    ).map((e) => e.name);
    expect(sorted).toEqual(['unknown', 'known']);
  });

  it('falls back to the name so the order is total and stable', () => {
    const a = entry({ name: 'a', size: 1 });
    const b = entry({ name: 'b', size: 1 });
    expect(compareEntries(a, b, { key: 'size', direction: 'asc' })).toBeLessThan(0);
    expect(compareEntries(a, b, { key: 'size', direction: 'desc' })).toBeGreaterThan(0);
  });
});

describe('nextSort', () => {
  it('starts a new column ascending', () => {
    expect(nextSort(ASC, 'size')).toEqual({ key: 'size', direction: 'asc' });
  });

  it('flips the direction of the same column', () => {
    expect(nextSort(ASC, 'name')).toEqual({ key: 'name', direction: 'desc' });
    expect(nextSort(DESC, 'name')).toEqual({ key: 'name', direction: 'asc' });
  });
});

describe('filterEntries', () => {
  const entries = [entry({ name: 'visible' }), entry({ name: '.hidden' })];

  it('hides dotfiles when showHidden is off', () => {
    expect(filterEntries(entries, false).map((e) => e.name)).toEqual(['visible']);
  });

  it('shows them when it is on', () => {
    expect(filterEntries(entries, true)).toHaveLength(2);
  });

  it('applies a case-insensitive name filter', () => {
    expect(filterEntries(entries, true, 'HID').map((e) => e.name)).toEqual(['.hidden']);
  });
});

describe('countEntries', () => {
  it('counts files and folders separately and sums only file bytes', () => {
    expect(
      countEntries([
        entry({ name: 'd', isDir: true, size: 4096 }),
        entry({ name: 'a', size: 100 }),
        entry({ name: 'b', size: 50 }),
      ]),
    ).toEqual({ files: 2, folders: 1, bytes: 150 });
  });
});

// ── Selection ───────────────────────────────────────────────────────────────

describe('selection', () => {
  const paths = ['/a', '/b', '/c', '/d', '/e'];

  it('takes an inclusive range in either direction', () => {
    expect(rangeBetween(paths, '/b', '/d')).toEqual(['/b', '/c', '/d']);
    expect(rangeBetween(paths, '/d', '/b')).toEqual(['/b', '/c', '/d']);
  });

  it('returns just the target when the anchor is gone', () => {
    expect(rangeBetween(paths, '/missing', '/c')).toEqual(['/c']);
  });

  it('replaces the selection on a plain click', () => {
    const next = selectOnClick(paths, { selected: ['/a', '/b'], anchor: '/a' }, '/d', {
      toggle: false,
      range: false,
    });
    expect(next).toEqual({ selected: ['/d'], anchor: '/d' });
  });

  it('toggles on a ctrl click, both ways', () => {
    const added = selectOnClick(paths, { selected: ['/a'], anchor: '/a' }, '/c', {
      toggle: true,
      range: false,
    });
    expect(added.selected).toEqual(['/a', '/c']);

    const removed = selectOnClick(paths, added, '/a', { toggle: true, range: false });
    expect(removed.selected).toEqual(['/c']);
  });

  it('extends from the anchor on a shift click and keeps the anchor', () => {
    const next = selectOnClick(paths, { selected: ['/b'], anchor: '/b' }, '/d', {
      toggle: false,
      range: true,
    });
    expect(next).toEqual({ selected: ['/b', '/c', '/d'], anchor: '/b' });
  });

  it('shrinks rather than growing a second range when shift reverses', () => {
    const grown = selectOnClick(paths, { selected: ['/b'], anchor: '/b' }, '/e', {
      toggle: false,
      range: true,
    });
    const shrunk = selectOnClick(paths, grown, '/c', { toggle: false, range: true });
    expect(shrunk.selected).toEqual(['/b', '/c']);
  });

  it('treats a shift click with no anchor as a plain click', () => {
    const next = selectOnClick(paths, { selected: [], anchor: null }, '/c', {
      toggle: false,
      range: true,
    });
    expect(next).toEqual({ selected: ['/c'], anchor: '/c' });
  });

  it('replaces on an unmodified arrow move and extends from the anchor otherwise', () => {
    expect(selectOnMove(paths, { selected: ['/a'], anchor: '/a' }, '/b', false)).toEqual({
      selected: ['/b'],
      anchor: '/b',
    });
    expect(selectOnMove(paths, { selected: ['/a'], anchor: '/a' }, '/c', true)).toEqual({
      selected: ['/a', '/b', '/c'],
      anchor: '/a',
    });
  });
});

describe('moveIndex', () => {
  it('clamps at both ends instead of wrapping', () => {
    expect(moveIndex(0, -1, 5)).toBe(0);
    expect(moveIndex(4, 1, 5)).toBe(4);
    expect(moveIndex(2, 12, 5)).toBe(4);
  });

  it('starts at the first row going down and the last going up', () => {
    expect(moveIndex(-1, 1, 5)).toBe(0);
    expect(moveIndex(-1, -1, 5)).toBe(4);
  });

  it('reports no row for an empty list', () => {
    expect(moveIndex(-1, 1, 0)).toBe(-1);
  });
});

describe('typeAheadIndex', () => {
  const names = ['alpha', 'beta', 'Bravo', 'gamma'];

  it('finds the next match after the cursor, case-insensitively', () => {
    expect(typeAheadIndex(names, 'b', -1)).toBe(1);
    expect(typeAheadIndex(names, 'b', 1)).toBe(2);
  });

  it('wraps around exactly once', () => {
    expect(typeAheadIndex(names, 'a', 3)).toBe(0);
  });

  it('returns null when nothing matches, so the cursor stays put', () => {
    expect(typeAheadIndex(names, 'zz', 0)).toBeNull();
    expect(typeAheadIndex([], 'a', 0)).toBeNull();
  });
});

// ── Transfers ───────────────────────────────────────────────────────────────

describe('policyForMode', () => {
  it('has no backend policy for ask', () => {
    expect(policyForMode('ask')).toBeNull();
  });

  it('passes the concrete policies through', () => {
    expect(policyForMode('overwrite')).toBe('overwrite');
    expect(policyForMode('skip')).toBe('skip');
    expect(policyForMode('rename')).toBe('rename');
  });
});

describe('buildEnqueueItems', () => {
  const entries = [entry({ name: 'a.txt', path: 'C:\\work\\a.txt' }), entry({ name: 'sub', path: 'C:\\work\\sub', isDir: true })];

  it('builds uploads joining the remote directory with POSIX separators', () => {
    const items = buildEnqueueItems({
      entries,
      direction: 'upload',
      localDir: 'C:\\work',
      remoteDir: '/var/www',
      policy: 'overwrite',
    });
    expect(items).toEqual([
      {
        direction: 'upload',
        localPath: 'C:\\work\\a.txt',
        remotePath: '/var/www/a.txt',
        isDir: false,
        onConflict: 'overwrite',
      },
      {
        direction: 'upload',
        localPath: 'C:\\work\\sub',
        remotePath: '/var/www/sub',
        isDir: true,
        onConflict: 'overwrite',
      },
    ]);
  });

  it('builds downloads joining the local directory with its own separator', () => {
    const items = buildEnqueueItems({
      entries: [entry({ name: 'b.log', path: '/var/log/b.log' })],
      direction: 'download',
      localDir: 'C:\\logs',
      remoteDir: '/var/log',
      policy: 'skip',
    });
    expect(items[0]).toEqual({
      direction: 'download',
      localPath: 'C:\\logs\\b.log',
      remotePath: '/var/log/b.log',
      isDir: false,
      onConflict: 'skip',
    });
  });

  it('never expands a directory — the backend does that with guards', () => {
    const items = buildEnqueueItems({
      entries,
      direction: 'upload',
      localDir: 'C:\\work',
      remoteDir: '/var/www',
      policy: 'rename',
    });
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.isDir)).toHaveLength(1);
  });
});

describe('findConflicts', () => {
  it('finds exact name collisions', () => {
    const found = findConflicts([{ name: 'a.txt' }, { name: 'b.txt' }], ['a.txt', 'c.txt']);
    expect(found).toEqual([{ name: 'a.txt' }]);
  });

  it('is case sensitive by default, for POSIX remotes', () => {
    expect(findConflicts([{ name: 'README' }], ['readme'])).toEqual([]);
  });

  it('collides case-insensitively when asked, for Windows destinations', () => {
    expect(findConflicts([{ name: 'README' }], ['readme'], true)).toEqual([
      { name: 'README' },
    ]);
  });
});

describe('isCaseInsensitiveSide', () => {
  it('is true for a Windows drive path and a UNC share', () => {
    expect(isCaseInsensitiveSide('local', 'C:\\Users')).toBe(true);
    expect(isCaseInsensitiveSide('local', '\\\\srv\\share')).toBe(true);
  });

  it('is false for a POSIX local path and for any remote', () => {
    expect(isCaseInsensitiveSide('local', '/home/me')).toBe(false);
    expect(isCaseInsensitiveSide('remote', 'C:\\Users')).toBe(false);
  });
});

// ── Drag payloads ───────────────────────────────────────────────────────────

describe('parseDrag', () => {
  it('round-trips a payload it serialized', () => {
    const payload = {
      side: 'local' as const,
      sessionId: 's1',
      entries: [entry({ name: 'a.txt' })],
    };
    expect(parseDrag(serializeDrag(payload))).toEqual(payload);
  });

  it('returns null instead of throwing on junk', () => {
    expect(parseDrag('not json')).toBeNull();
    expect(parseDrag('')).toBeNull();
    expect(parseDrag(null)).toBeNull();
    expect(parseDrag('null')).toBeNull();
    expect(parseDrag('{"side":"nowhere","entries":[]}')).toBeNull();
    expect(parseDrag('{"side":"local","entries":[{"nope":1}]}')).toBeNull();
  });

  it('normalises a missing session id to null', () => {
    const parsed = parseDrag(
      JSON.stringify({ side: 'remote', entries: [entry({ name: 'x' })] }),
    );
    expect(parsed?.sessionId).toBeNull();
  });
});

// ── Clipboard and query keys ────────────────────────────────────────────────

describe('path clipboard', () => {
  beforeEach(() => setPathClipboard(null));

  it('remembers and clears a copy', () => {
    expect(getPathClipboard()).toBeNull();
    setPathClipboard({ side: 'remote', sessionId: 's1', entries: [entry({ name: 'a' })] });
    expect(getPathClipboard()?.side).toBe('remote');
    setPathClipboard(null);
    expect(getPathClipboard()).toBeNull();
  });
});

describe('listingQueryKey', () => {
  it('includes the session so a tab switch cannot show a cached foreign folder', () => {
    expect(listingQueryKey('remote', 's1', '/var')).not.toEqual(
      listingQueryKey('remote', 's2', '/var'),
    );
  });

  it('has a stable placeholder for the session-less local pane', () => {
    expect(listingQueryKey('local', null, 'C:\\')).toEqual([
      'listing',
      'local',
      'no-session',
      'C:\\',
    ]);
  });
});

// ── Navigation, including the roots the old code mishandled ─────────────────

describe('path navigation used by the panes', () => {
  it('stops at a Windows drive root', () => {
    expect(parentPath('C:\\Users\\me', false)).toBe('C:\\Users');
    expect(parentPath('C:\\Users', false)).toBe('C:\\');
    expect(parentPath('C:\\', false)).toBeNull();
  });

  it('stops at a UNC share root', () => {
    expect(parentPath('\\\\server\\share\\dir', false)).toBe('\\\\server\\share');
    expect(parentPath('\\\\server\\share', false)).toBeNull();
  });

  it('stops at the POSIX remote root', () => {
    expect(parentPath('/var/www/html', true)).toBe('/var/www');
    expect(parentPath('/var', true)).toBe('/');
    expect(parentPath('/', true)).toBeNull();
  });
});
