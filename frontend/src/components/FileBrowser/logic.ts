/**
 * Pure logic behind the file panes: normalisation, sorting, filtering,
 * selection algebra, conflict detection and enqueue construction.
 *
 * Nothing here touches React, a store or the IPC bridge, so all of it is unit
 * tested. The old `FilePanels.tsx` inlined every one of these rules inside JSX,
 * which is why sorting, hidden-file filtering and range selection were all
 * subtly wrong at once.
 */
import { joinPath } from '../../lib/format';
import type {
  ConflictPolicy,
  EnqueueItem,
  LocalFile,
  OverwriteMode,
  PaneSide,
  RemoteFile,
  SortState,
  TransferDirection,
} from '../../lib/types';

/**
 * One row, whichever pane it came from. The two backend listings carry
 * different fields; normalising once means the row component, the sorter and
 * the transfer builder each have exactly one shape to reason about.
 */
export interface PaneEntry {
  name: string;
  /** Absolute path, in the separator convention of its own side. */
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  /** Remote only, and only when the server reported it. */
  symlinkTarget: string | null;
  size: number;
  /** RFC 3339, or null when unknown — never fabricate a date. */
  modified: string | null;
  /** Symbolic or octal, as reported. Null when the side has no notion of it. */
  permissions: string | null;
  mode: number | null;
  /** Remote only, when the server reports them. */
  owner: string | null;
  group: string | null;
  hidden: boolean;
  /** Local only: the entry cannot be written. */
  readonly: boolean;
}

/** Dotfile convention. Remote listings do not carry a hidden flag. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..';
}

export function fromRemoteFile(file: RemoteFile): PaneEntry {
  return {
    name: file.name,
    path: file.path,
    isDir: file.isDir,
    isSymlink: file.isSymlink,
    symlinkTarget: file.symlinkTarget,
    size: file.size,
    modified: file.modified,
    permissions: file.permissions,
    mode: file.mode,
    owner: file.owner,
    group: file.group,
    hidden: isHiddenName(file.name),
    readonly: false,
  };
}

/**
 * Back to the wire shape, for commands that take a `RemoteFile` — the chmod
 * dialog's payload, for instance. Only ever called for remote entries.
 */
export function toRemoteFile(entry: PaneEntry): RemoteFile {
  return {
    name: entry.name,
    path: entry.path,
    size: entry.size,
    isDir: entry.isDir,
    isSymlink: entry.isSymlink,
    symlinkTarget: entry.symlinkTarget,
    permissions: entry.permissions,
    mode: entry.mode,
    modified: entry.modified,
    owner: entry.owner,
    group: entry.group,
  };
}

export function fromLocalFile(file: LocalFile): PaneEntry {
  return {
    name: file.name,
    path: file.path,
    isDir: file.isDir,
    isSymlink: file.isSymlink,
    symlinkTarget: null,
    size: file.size,
    modified: file.modified,
    permissions: null,
    mode: null,
    owner: null,
    group: null,
    // The backend's own hidden flag knows about Windows attributes; the dotfile
    // rule is only a fallback for platforms that do not report one.
    hidden: file.isHidden || isHiddenName(file.name),
    readonly: file.readonly,
  };
}

// ── Sorting ─────────────────────────────────────────────────────────────────

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function byName(a: PaneEntry, b: PaneEntry): number {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Folders always come first, in both sort directions — that grouping is a
 * navigation aid, not a sort key, so reversing the sort must not scatter it.
 */
export function compareEntries(a: PaneEntry, b: PaneEntry, sort: SortState): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;

  let result = 0;
  switch (sort.key) {
    case 'name':
      result = byName(a, b);
      break;
    case 'size':
      result = a.size - b.size;
      break;
    case 'modified':
      result = timestamp(a.modified) - timestamp(b.modified);
      break;
    case 'permissions':
      result = (a.permissions ?? '').localeCompare(b.permissions ?? '');
      break;
  }
  // Name is the tiebreaker so the order is total and rendering is stable.
  if (result === 0) result = byName(a, b);
  return sort.direction === 'asc' ? result : -result;
}

export function sortEntries(entries: readonly PaneEntry[], sort: SortState): PaneEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, sort));
}

/** `showHiddenFiles` applies to **both** panes; it used to apply only to remote. */
export function filterEntries(
  entries: readonly PaneEntry[],
  showHidden: boolean,
  query = '',
): PaneEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!showHidden && entry.hidden) return false;
    if (needle !== '' && !entry.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** The next sort state for a header click: same column flips, new column starts ascending. */
export function nextSort(current: SortState, key: SortState['key']): SortState {
  if (current.key !== key) return { key, direction: 'asc' };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

// ── Selection ───────────────────────────────────────────────────────────────

export interface SelectionState {
  /** Absolute paths, in no particular order. */
  selected: string[];
  /** The path a Shift-range extends from. */
  anchor: string | null;
}

export interface ClickModifiers {
  /** Ctrl on Windows/Linux, Cmd on macOS — the caller normalises. */
  toggle: boolean;
  range: boolean;
}

/** Inclusive slice of `paths` between two members, in either order. */
export function rangeBetween(paths: readonly string[], from: string, to: string): string[] {
  const start = paths.indexOf(from);
  const end = paths.indexOf(to);
  if (start < 0 || end < 0) return end < 0 ? [] : [to];
  return start <= end ? paths.slice(start, end + 1) : paths.slice(end, start + 1);
}

/**
 * Selection after a click. Plain click replaces, Ctrl-click toggles, Shift-click
 * extends from the anchor. A Shift-click with no anchor behaves like a plain
 * click rather than selecting nothing, which is what the old code did.
 */
export function selectOnClick(
  paths: readonly string[],
  current: SelectionState,
  path: string,
  mods: ClickModifiers,
): SelectionState {
  if (mods.range) {
    const from = current.anchor ?? path;
    return { selected: rangeBetween(paths, from, path), anchor: from };
  }
  if (mods.toggle) {
    const selected = current.selected.includes(path)
      ? current.selected.filter((p) => p !== path)
      : [...current.selected, path];
    return { selected, anchor: path };
  }
  return { selected: [path], anchor: path };
}

/**
 * Selection after an arrow key. `extend` keeps the anchor and re-slices, so
 * holding Shift and reversing direction shrinks the range instead of growing a
 * second one.
 */
export function selectOnMove(
  paths: readonly string[],
  current: SelectionState,
  targetPath: string,
  extend: boolean,
): SelectionState {
  if (!extend) return { selected: [targetPath], anchor: targetPath };
  const from = current.anchor ?? targetPath;
  return { selected: rangeBetween(paths, from, targetPath), anchor: from };
}

/** Clamp a cursor move to the list, so Down at the end stays at the end. */
export function moveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + delta));
}

/**
 * Type-ahead: first name starting with `query`, searching after `fromIndex`
 * and wrapping once. Returns null when nothing matches, so the cursor stays put
 * instead of jumping to row 0.
 */
export function typeAheadIndex(
  names: readonly string[],
  query: string,
  fromIndex: number,
): number | null {
  const needle = query.toLowerCase();
  if (needle === '' || names.length === 0) return null;
  for (let step = 1; step <= names.length; step += 1) {
    const index = (Math.max(fromIndex, -1) + step + names.length) % names.length;
    if (names[index].toLowerCase().startsWith(needle)) return index;
  }
  return null;
}

// ── Transfers ───────────────────────────────────────────────────────────────

/**
 * Resolve the `overwriteMode` setting into a policy the backend accepts.
 * `ask` has no backend equivalent: the caller must resolve it through the
 * conflict dialog first, and this function only says so.
 */
export function policyForMode(mode: OverwriteMode): ConflictPolicy | null {
  return mode === 'ask' ? null : mode;
}

export interface TransferPlanArgs {
  entries: readonly PaneEntry[];
  direction: TransferDirection;
  /** Destination directory for a download, source directory for an upload. */
  localDir: string;
  remoteDir: string;
  policy: ConflictPolicy;
}

/**
 * Build the `EnqueueItem[]` for a transfer.
 *
 * Directories are passed through with `isDir: true` and **not** walked here —
 * the backend expands them with symlink and depth guards. The old frontend
 * recursed itself, with no symlink protection, and could loop forever.
 */
export function buildEnqueueItems({
  entries,
  direction,
  localDir,
  remoteDir,
  policy,
}: TransferPlanArgs): EnqueueItem[] {
  return entries.map((entry) => {
    if (direction === 'upload') {
      return {
        direction,
        localPath: entry.path,
        remotePath: joinPath(remoteDir, entry.name, true),
        isDir: entry.isDir,
        onConflict: policy,
      };
    }
    return {
      direction,
      localPath: joinPath(localDir, entry.name, false),
      remotePath: entry.path,
      isDir: entry.isDir,
      onConflict: policy,
    };
  });
}

/**
 * Which of `items` would land on something that already exists.
 *
 * `caseInsensitive` is on for Windows destinations, where `README` and
 * `readme` are the same file and a case-sensitive check would silently
 * overwrite.
 */
export function findConflicts<T extends { name: string }>(
  items: readonly T[],
  destinationNames: Iterable<string>,
  caseInsensitive = false,
): T[] {
  const taken = new Set<string>();
  for (const name of destinationNames) {
    taken.add(caseInsensitive ? name.toLowerCase() : name);
  }
  return items.filter((item) => taken.has(caseInsensitive ? item.name.toLowerCase() : item.name));
}

/** Windows and macOS destinations collide case-insensitively; remote POSIX does not. */
export function isCaseInsensitiveSide(side: PaneSide, localPath: string): boolean {
  return side === 'local' && /^[A-Za-z]:|^\\\\/.test(localPath);
}

// ── Cross-pane clipboard ────────────────────────────────────────────────────

export interface PathClipboard {
  side: PaneSide;
  sessionId: string | null;
  entries: PaneEntry[];
}

let clipboard: PathClipboard | null = null;

/** Ctrl+C in a pane records what a later Ctrl+V in the other pane transfers. */
export function setPathClipboard(next: PathClipboard | null): void {
  clipboard = next;
}

export function getPathClipboard(): PathClipboard | null {
  return clipboard;
}

// ── Drag payloads ───────────────────────────────────────────────────────────

/** Custom MIME type so a drag from another app is never mistaken for ours. */
export const DRAG_MIME = 'application/x-ftpie-entries';

export interface DragPayload {
  side: PaneSide;
  sessionId: string | null;
  entries: PaneEntry[];
}

export function serializeDrag(payload: DragPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse a drag payload defensively. The old code called `JSON.parse` on
 * whatever `dataTransfer` held, unguarded, so any foreign drag threw inside an
 * event handler and left the pane in a half-dragging state.
 */
export function parseDrag(raw: string | null | undefined): DragPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<DragPayload>;
  if (candidate.side !== 'local' && candidate.side !== 'remote') return null;
  if (!Array.isArray(candidate.entries) || candidate.entries.length === 0) return null;
  const entries = candidate.entries.filter(
    (entry): entry is PaneEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as PaneEntry).name === 'string' &&
      typeof (entry as PaneEntry).path === 'string' &&
      typeof (entry as PaneEntry).isDir === 'boolean',
  );
  if (entries.length === 0) return null;
  return {
    side: candidate.side,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : null,
    entries,
  };
}

// ── Query keys ──────────────────────────────────────────────────────────────

/**
 * React Query key for one listing. Includes the session id so switching tabs
 * cannot show the previous server's cached directory.
 */
export function listingQueryKey(
  side: PaneSide,
  sessionId: string | null,
  path: string,
): readonly unknown[] {
  return ['listing', side, sessionId ?? 'no-session', path];
}

/** Aggregate counts for the pane footer. */
export function countEntries(entries: readonly PaneEntry[]): {
  files: number;
  folders: number;
  bytes: number;
} {
  let files = 0;
  let folders = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (entry.isDir) folders += 1;
    else {
      files += 1;
      bytes += entry.size;
    }
  }
  return { files, folders, bytes };
}
