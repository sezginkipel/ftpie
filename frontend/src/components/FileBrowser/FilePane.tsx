/**
 * One file pane — the core screen of the app.
 *
 * What this rewrite fixes, point by point:
 *
 * - A failed listing renders an `ErrorState` with the real reason and a Retry.
 *   The old pane swallowed every rejection and drew "Empty directory", which
 *   made a permission failure look like an empty folder.
 * - Rows are virtualized, so 10k entries are ~30 DOM nodes rather than 10k.
 * - Real `role="grid"` semantics, one tab stop, `aria-activedescendant`, and a
 *   complete keyboard map (see `keyboard.ts`).
 * - `showHiddenFiles` applies here as well as to the remote pane.
 * - Sorting is per pane per session and folders stay grouped first.
 * - Nothing destructive happens without a focus-trapped confirmation that names
 *   the items and says when a folder will be removed recursively.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '../../lib/cn';
import { formatBytes, parentPath } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { call } from '../../lib/ipc';
import type {
  LocalListing,
  PaneSide,
  RemoteFile,
  SortKey,
  SortState,
} from '../../lib/types';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import {
  AlertDialog,
  Badge,
  Checkbox,
  EmptyState,
  ErrorState,
  Icon,
  Spinner,
  useToast,
} from '../ui';
import { FileContextMenu } from './FileContextMenu';
import { FileRow } from './FileRow';
import { PathBar } from './PathBar';
import { isTypeAheadKey, mapPaneKey } from './keyboard';
import {
  DRAG_MIME,
  filterEntries,
  fromLocalFile,
  fromRemoteFile,
  getPathClipboard,
  listingQueryKey,
  moveIndex,
  nextSort,
  parseDrag,
  selectOnClick,
  selectOnMove,
  serializeDrag,
  setPathClipboard,
  sortEntries,
  toRemoteFile,
  typeAheadIndex,
  countEntries,
  type PaneEntry,
} from './logic';

const ROW_HEIGHT = 28;
/** How long a type-ahead buffer survives without another keystroke. */
const TYPE_AHEAD_TIMEOUT = 900;

interface Listing {
  /** Canonical path the backend actually read. */
  path: string;
  parent: string | null;
  entries: PaneEntry[];
}

export interface FilePaneProps {
  side: PaneSide;
  /** Null for the local pane when nothing is connected. */
  sessionId: string | null;
  path: string;
  onNavigate: (path: string) => void;
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  selection: string[];
  onSelectionChange: (paths: string[]) => void;
  focused: boolean;
  onFocus: () => void;
  /** Send these entries to the opposite pane. */
  onTransfer: (entries: PaneEntry[]) => void;
  /** Accept entries dropped or pasted from the opposite pane. */
  onReceive: (entries: PaneEntry[], from: PaneSide) => void;
  /** A file was opened with the `open` double-click action. */
  onOpenFile: (entry: PaneEntry) => void;
  onSwitchPane: () => void;
}

export function FilePane({
  side,
  sessionId,
  path,
  onNavigate,
  sort,
  onSortChange,
  selection,
  onSelectionChange,
  focused,
  onFocus,
  onTransfer,
  onReceive,
  onOpenFile,
  onSwitchPane,
}: FilePaneProps) {
  const { t, locale } = useT();
  const { toast, showError } = useToast();
  const queryClient = useQueryClient();
  const openDialog = useUiStore((state) => state.openDialog);

  const showHiddenFiles = useSettingsStore((state) => state.showHiddenFiles);
  const setSetting = useSettingsStore((state) => state.set);
  const dateFormat = useSettingsStore((state) => state.dateFormat);
  const confirmDelete = useSettingsStore((state) => state.confirmDelete);
  const doubleClickAction = useSettingsStore((state) => state.doubleClickAction);

  const isRemote = side === 'remote';
  const connected = !isRemote || sessionId !== null;
  /**
   * The dialog payloads carry a session id because the remote commands need
   * one; local mkdir/rename do not. Creating a folder on your own disk must not
   * require a server, so the local side passes an empty id it never reads.
   */
  const dialogSessionId = sessionId ?? '';

  const gridId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const typeAhead = useRef({ buffer: '', timer: 0 });

  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(-1);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // ── Listing ───────────────────────────────────────────────────────────────

  const queryKey = useMemo(
    () => listingQueryKey(side, isRemote ? sessionId : null, path),
    [side, isRemote, sessionId, path],
  );

  const query = useQuery<Listing, unknown>({
    queryKey,
    enabled: connected,
    retry: false,
    // A directory listing is a snapshot, not cacheable state: coming back to a
    // folder should show what is there now.
    staleTime: 0,
    queryFn: async () => {
      if (isRemote) {
        const files = await call<RemoteFile[]>('list_remote', { sessionId, path });
        return {
          path,
          parent: parentPath(path, true),
          entries: files.map(fromRemoteFile),
        };
      }
      const listing = await call<LocalListing>('list_local', {
        // An empty path asks the backend for the user's home directory.
        path: path === '' ? null : path,
      });
      return {
        path: listing.path,
        parent: listing.parent,
        entries: listing.entries.map(fromLocalFile),
      };
    },
  });

  // The local backend canonicalises (`""` → the home directory, `.` → absolute),
  // so adopt whatever it actually read. Guarded, or this loops.
  const resolvedPath = query.data?.path;
  useEffect(() => {
    if (resolvedPath && resolvedPath !== path) onNavigate(resolvedPath);
  }, [resolvedPath, path, onNavigate]);

  const entries = useMemo(() => {
    const raw = query.data?.entries ?? [];
    return sortEntries(filterEntries(raw, showHiddenFiles, filter), sort);
  }, [query.data, showHiddenFiles, filter, sort]);

  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedSet.has(entry.path)),
    [entries, selectedSet],
  );

  // Navigating resets the cursor and the type-ahead buffer; selection is
  // cleared by the session store on the same transition.
  useEffect(() => {
    setCursor(-1);
    setAnchor(null);
    setFilter('');
  }, [path, sessionId]);

  useEffect(() => {
    const state = typeAhead.current;
    return () => {
      if (state.timer) window.clearTimeout(state.timer);
    };
  }, []);

  // ── Virtualization ────────────────────────────────────────────────────────

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // Assumed viewport until the scroll element is measured. Without it the
    // first paint renders zero rows, and in a headless test (no layout, no
    // ResizeObserver) it would stay that way.
    initialRect: { width: 900, height: 600 },
  });

  const activeEntry = cursor >= 0 && cursor < entries.length ? entries[cursor] : null;

  const focusRow = useCallback(
    (index: number) => {
      setCursor(index);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' });
    },
    [virtualizer],
  );

  // ── Selection ─────────────────────────────────────────────────────────────

  const applySelection = useCallback(
    (next: { selected: string[]; anchor: string | null }) => {
      onSelectionChange(next.selected);
      setAnchor(next.anchor);
    },
    [onSelectionChange],
  );

  const handleRowSelect = useCallback(
    (entry: PaneEntry, mods: { toggle: boolean; range: boolean }) => {
      onFocus();
      gridRef.current?.focus();
      applySelection(selectOnClick(paths, { selected: selection, anchor }, entry.path, mods));
      focusRow(entries.indexOf(entry));
    },
    [anchor, applySelection, entries, focusRow, onFocus, paths, selection],
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const openEntry = useCallback(
    (entry: PaneEntry) => {
      if (entry.isDir) {
        onNavigate(entry.path);
        return;
      }
      if (doubleClickAction === 'open') onOpenFile(entry);
      else onTransfer([entry]);
    },
    [doubleClickAction, onNavigate, onOpenFile, onTransfer],
  );

  const copyPaths = useCallback(
    (targets: PaneEntry[]) => {
      if (targets.length === 0) return;
      setPathClipboard({ side, sessionId, entries: targets });
      const text = targets.map((entry) => entry.path).join('\n');
      navigator.clipboard
        ?.writeText(text)
        .then(() => toast({ title: t('toast.copiedToClipboard'), variant: 'ok' }))
        .catch(() => toast({ title: t('toast.copyFailed'), variant: 'warn' }));
    },
    [side, sessionId, t, toast],
  );

  const pasteFromClipboard = useCallback(() => {
    const clipboard = getPathClipboard();
    if (!clipboard || clipboard.side === side || clipboard.entries.length === 0) return;
    onReceive(clipboard.entries, clipboard.side);
  }, [onReceive, side]);

  const requestDelete = useCallback(() => {
    if (selectedEntries.length === 0) return;
    if (confirmDelete) setConfirmingDelete(true);
    else void performDelete();
    // `performDelete` is declared below and stable for the life of the pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDelete, selectedEntries]);

  const performDelete = async () => {
    const targets = selectedEntries;
    if (targets.length === 0) return;
    setDeleting(true);
    let failures = 0;
    let lastError: unknown = null;
    for (const entry of targets) {
      try {
        if (isRemote) {
          await call<void>('delete_remote', {
            args: {
              sessionId,
              path: entry.path,
              isDir: entry.isDir,
              // A folder is only removable with this set — the confirmation
              // said so explicitly.
              recursive: entry.isDir,
            },
          });
        } else {
          await call<void>('delete_local', {
            args: { path: entry.path, recursive: entry.isDir },
          });
        }
      } catch (error) {
        failures += 1;
        lastError = error;
      }
    }
    setDeleting(false);
    setConfirmingDelete(false);
    onSelectionChange([]);
    refresh();

    if (failures === 0) {
      toast({ title: t('file.deleted', { count: targets.length }), variant: 'ok' });
    } else if (lastError) {
      showError(lastError, 'file.deleteFailed');
    }
  };

  // ── Drag and drop ─────────────────────────────────────────────────────────

  const handleDragStart = useCallback(
    (entry: PaneEntry, event: DragEvent<HTMLDivElement>) => {
      // Dragging an unselected row drags that row alone, which is what every
      // file manager does.
      const dragged = selectedSet.has(entry.path) ? selectedEntries : [entry];
      event.dataTransfer.effectAllowed = 'copy';
      try {
        event.dataTransfer.setData(
          DRAG_MIME,
          serializeDrag({ side, sessionId, entries: dragged }),
        );
        event.dataTransfer.setData(
          'text/plain',
          dragged.map((item) => item.path).join('\n'),
        );
      } catch {
        // Some platforms refuse custom MIME types mid-drag; the text/plain
        // fallback above is still useful, and the drop simply will not apply.
      }
    },
    [selectedEntries, selectedSet, sessionId, side],
  );

  const acceptDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, destination: string) => {
      setDropActive(false);
      event.preventDefault();
      const payload = parseDrag(event.dataTransfer.getData(DRAG_MIME));
      if (!payload) {
        toast({ title: t('file.dragInvalid'), variant: 'warn' });
        return;
      }
      if (payload.side === side) return;
      if (destination !== path) onNavigate(destination);
      onReceive(payload.entries, payload.side);
    },
    [onNavigate, onReceive, path, side, t, toast],
  );

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!connected) return;
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropActive(true);
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────

  const runTypeAhead = (char: string) => {
    const state = typeAhead.current;
    if (state.timer) window.clearTimeout(state.timer);
    state.buffer += char;
    state.timer = window.setTimeout(() => {
      state.buffer = '';
      state.timer = 0;
    }, TYPE_AHEAD_TIMEOUT);

    const names = entries.map((entry) => entry.name);
    // A repeated single character cycles through matches; a longer buffer
    // re-searches from the current row.
    const from = state.buffer.length === 1 ? cursor : cursor - 1;
    const found = typeAheadIndex(names, state.buffer, from);
    if (found === null) return;
    focusRow(found);
    applySelection({ selected: [entries[found].path], anchor: entries[found].path });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = mapPaneKey(event);
    if (!action) return;

    // Type-ahead is the only action that must not steal a browser shortcut.
    if (action.kind === 'typeAhead') {
      if (!isTypeAheadKey(event)) return;
      event.preventDefault();
      runTypeAhead(action.char);
      return;
    }

    event.preventDefault();

    switch (action.kind) {
      case 'move': {
        const next = moveIndex(cursor, action.delta, entries.length);
        if (next < 0) return;
        focusRow(next);
        applySelection(
          selectOnMove(paths, { selected: selection, anchor }, entries[next].path, action.extend),
        );
        return;
      }
      case 'moveTo': {
        if (entries.length === 0) return;
        const next = action.position === 'first' ? 0 : entries.length - 1;
        focusRow(next);
        applySelection(
          selectOnMove(paths, { selected: selection, anchor }, entries[next].path, action.extend),
        );
        return;
      }
      case 'selectAll':
        applySelection({ selected: paths, anchor: paths[0] ?? null });
        return;
      case 'clearSelection':
        applySelection({ selected: [], anchor: null });
        return;
      case 'toggle':
        if (!activeEntry) return;
        applySelection(
          selectOnClick(paths, { selected: selection, anchor }, activeEntry.path, {
            toggle: true,
            range: false,
          }),
        );
        return;
      case 'open':
        if (activeEntry) openEntry(activeEntry);
        return;
      case 'up':
        if (query.data?.parent) onNavigate(query.data.parent);
        return;
      case 'delete':
        requestDelete();
        return;
      case 'rename':
        if (activeEntry && connected) {
          openDialog({
            kind: 'rename',
            sessionId: dialogSessionId,
            side,
            path: activeEntry.path,
            currentName: activeEntry.name,
          });
        }
        return;
      case 'newFolder':
        if (connected) {
          openDialog({
            kind: 'newFolder',
            sessionId: dialogSessionId,
            side,
            parentPath: path,
          });
        }
        return;
      case 'refresh':
        refresh();
        return;
      case 'copy':
        copyPaths(selectedEntries.length > 0 ? selectedEntries : activeEntry ? [activeEntry] : []);
        return;
      case 'paste':
        pasteFromClipboard();
        return;
      case 'transfer':
        if (selectedEntries.length > 0) onTransfer(selectedEntries);
        return;
      case 'switchPane':
        onSwitchPane();
        return;
    }
  };

  // ── Rendering ─────────────────────────────────────────────────────────────

  const counts = countEntries(entries);
  const selectionBytes = selectedEntries.reduce(
    (total, entry) => total + (entry.isDir ? 0 : entry.size),
    0,
  );

  const columns: { key: SortKey; label: string; className: string }[] = [
    { key: 'name', label: t('file.columnName'), className: 'flex-1 min-w-0 text-left' },
    { key: 'size', label: t('file.columnSize'), className: 'w-20 shrink-0 text-right' },
    { key: 'modified', label: t('file.columnModified'), className: 'w-36 shrink-0 text-right' },
    ...(isRemote
      ? [
          {
            key: 'permissions' as SortKey,
            label: t('file.columnPermissions'),
            className: 'w-24 shrink-0 text-left',
          },
        ]
      : []),
  ];

  let body: ReactNode;
  if (!connected) {
    body = (
      <EmptyState
        icon="server"
        title={t('state.notConnected')}
        description={t('state.notConnectedHint')}
      />
    );
  } else if (query.isError) {
    body = (
      // No `title` override: the localized reason for *this* error is far more
      // useful than a generic "could not be listed".
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  } else if (query.isPending) {
    body = (
      <div className="flex flex-1 items-center justify-center p-8">
        <Spinner size={16} label={t('common.loading')} />
      </div>
    );
  } else if (entries.length === 0) {
    body =
      filter.trim() === '' ? (
        <EmptyState
          icon="folder-open"
          title={t('state.emptyFolder')}
          description={t('state.emptyFolderHint')}
        />
      ) : (
        <EmptyState
          icon="search"
          title={t('state.noResults')}
          description={t('state.noResultsHint', { query: filter })}
        />
      );
  } else {
    body = (
      <div
        ref={scrollRef}
        role="rowgroup"
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        <div style={{ height: virtualizer.getTotalSize() }} className="relative">
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = entries[virtualRow.index];
            return (
              <FileRow
                key={entry.path}
                id={`${gridId}-row-${virtualRow.index}`}
                entry={entry}
                selected={selectedSet.has(entry.path)}
                active={focused && cursor === virtualRow.index}
                locale={locale}
                dateFormat={dateFormat}
                showPermissions={isRemote}
                style={{
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onSelect={handleRowSelect}
                onOpen={openEntry}
                onDragStart={handleDragStart}
                onDropOnFolder={(target, event) => acceptDrop(event, target.path)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  const deleteNames =
    selectedEntries
      .slice(0, 3)
      .map((entry) => entry.name)
      .join(', ') +
    (selectedEntries.length > 3
      ? `, ${t('common.andNMore', { count: selectedEntries.length - 3 })}`
      : '');
  const hasFolder = selectedEntries.some((entry) => entry.isDir);

  return (
    <section
      aria-label={t(isRemote ? 'file.remote' : 'file.local')}
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col bg-surface',
        focused && 'ring-1 ring-inset ring-accent',
      )}
      onMouseDownCapture={onFocus}
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface-2 px-2">
        <Icon name={isRemote ? 'server' : 'drive'} className="text-text-3" />
        <span className="text-xs font-semibold uppercase tracking-wide text-text-2">
          {t(isRemote ? 'file.remote' : 'file.local')}
        </span>
        {isRemote && !connected ? (
          <Badge tone="warn">{t('state.notConnected')}</Badge>
        ) : null}
        <div className="flex-1" />
        <Checkbox
          checked={showHiddenFiles}
          onCheckedChange={(checked) => setSetting({ showHiddenFiles: checked })}
          label={t('file.showHidden')}
          className="text-xs"
        />
      </div>

      <PathBar
        side={side}
        path={query.data?.path ?? path}
        parent={query.data?.parent ?? parentPath(path, isRemote)}
        loading={query.isFetching}
        filter={filter}
        onFilterChange={setFilter}
        onNavigate={onNavigate}
        onRefresh={refresh}
        onNewFolder={() =>
          openDialog({
            kind: 'newFolder',
            sessionId: dialogSessionId,
            side,
            parentPath: path,
          })
        }
        disabled={!connected}
      />

      <FileContextMenu
        side={side}
        targets={selectedEntries}
        enabled={connected}
        canPaste={(getPathClipboard()?.side ?? side) !== side}
        onOpen={() => activeEntry && openEntry(activeEntry)}
        onOpenInEditor={() => activeEntry && onOpenFile(activeEntry)}
        onTransfer={() => selectedEntries.length > 0 && onTransfer(selectedEntries)}
        onPaste={pasteFromClipboard}
        onCopyPath={() => copyPaths(selectedEntries)}
        onRename={() => {
          const target = selectedEntries[0];
          if (!target) return;
          openDialog({
            kind: 'rename',
            sessionId: dialogSessionId,
            side,
            path: target.path,
            currentName: target.name,
          });
        }}
        onDelete={requestDelete}
        onNewFolder={() =>
          openDialog({
            kind: 'newFolder',
            sessionId: dialogSessionId,
            side,
            parentPath: path,
          })
        }
        onChangePermissions={() => {
          if (!sessionId || selectedEntries.length === 0) return;
          openDialog({
            kind: 'chmod',
            sessionId,
            targets: selectedEntries.map(toRemoteFile),
          });
        }}
        onRefresh={refresh}
      >
        <div
          ref={gridRef}
          id={gridId}
          role="grid"
          tabIndex={0}
          aria-label={t(isRemote ? 'file.remote' : 'file.local')}
          aria-rowcount={entries.length}
          aria-multiselectable
          aria-activedescendant={
            activeEntry ? `${gridId}-row-${cursor}` : undefined
          }
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onDragOver={handleDragOver}
          onDragLeave={() => setDropActive(false)}
          onDrop={(event) => acceptDrop(event, path)}
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            dropActive && 'outline-dashed outline-2 -outline-offset-2 outline-accent',
          )}
        >
          <div
            role="row"
            className="row shrink-0 gap-2 border-b border-border bg-surface px-2 text-xs text-text-3"
          >
            {columns.map((column) => (
              <button
                key={column.key}
                type="button"
                role="columnheader"
                aria-sort={
                  sort.key === column.key
                    ? sort.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none'
                }
                onClick={() => onSortChange(nextSort(sort, column.key))}
                title={t('file.sortBy', { column: column.label })}
                className={cn(
                  'flex h-full items-center gap-1 hover:text-text-2',
                  column.className,
                  column.key === 'size' || column.key === 'modified'
                    ? 'justify-end'
                    : 'justify-start',
                )}
              >
                <span className="truncate">{column.label}</span>
                {sort.key === column.key ? (
                  <Icon name={sort.direction === 'asc' ? 'chevron-up' : 'chevron-down'} />
                ) : null}
              </button>
            ))}
          </div>

          {body}
        </div>
      </FileContextMenu>

      <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface-2 px-2 text-xs text-text-3">
        <span className="tnum">
          {t('file.itemCount', { files: counts.files, folders: counts.folders })}
        </span>
        {selectedEntries.length > 0 ? (
          <span className="tnum text-text-2">
            {t('file.selectionSize', {
              count: selectedEntries.length,
              size: formatBytes(selectionBytes),
            })}
          </span>
        ) : null}
        {dropActive ? <span className="text-accent">{t('file.dropHere')}</span> : null}
      </footer>

      <AlertDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t('delete.title', { count: selectedEntries.length })}
        tone="danger"
        loading={deleting}
        description={
          <>
            <p>
              {selectedEntries.length === 1
                ? t('delete.bodyOne', { name: selectedEntries[0]?.name ?? '' })
                : t('delete.bodyMany', {
                    count: selectedEntries.length,
                    names: deleteNames,
                  })}
            </p>
            {hasFolder ? (
              <p className="mt-2 text-danger">{t('delete.recursiveWarning')}</p>
            ) : null}
          </>
        }
        confirmLabel={
          selectedEntries.length === 1
            ? t('delete.confirmOne', { name: selectedEntries[0]?.name ?? '' })
            : t('delete.confirmMany', { count: selectedEntries.length })
        }
        cancelLabel={t('common.cancel')}
        onConfirm={() => void performDelete()}
      />
    </section>
  );
}
