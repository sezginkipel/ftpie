/**
 * The two panes side by side, plus everything that spans them: the draggable
 * split, the transfer flow, and conflict resolution.
 *
 * The panes themselves are dumb about transfers on purpose — only this
 * component knows both paths, so only this component can build an
 * `EnqueueItem` or decide that a destination already has a file of that name.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { baseName, parentPath } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { call, isAppError } from '../../lib/ipc';
import type {
  LocalFile,
  LocalListing,
  PaneSide,
  RemoteFile,
  SortState,
} from '../../lib/types';
import { useEditorStore, isReopenConflict } from '../../store/editorStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore, type ConflictEntry } from '../../store/uiStore';
import { AlertDialog, useToast } from '../ui';
import { FilePane } from './FilePane';
import { useLocalPaneStore } from './localPane';
import {
  buildEnqueueItems,
  findConflicts,
  fromLocalFile,
  fromRemoteFile,
  isCaseInsensitiveSide,
  policyForMode,
  type PaneEntry,
} from './logic';

const DEFAULT_SORT: SortState = { key: 'name', direction: 'asc' };

export function Panes() {
  const { t } = useT();
  const { toast, showError } = useToast();

  const activeId = useSessionStore((state) => state.activeId);
  const ui = useSessionStore((state) =>
    state.activeId ? state.ui[state.activeId] : undefined,
  );
  const setRemotePath = useSessionStore((state) => state.setRemotePath);
  const setLocalPath = useSessionStore((state) => state.setLocalPath);
  const setSelection = useSessionStore((state) => state.setSelection);
  const setSort = useSessionStore((state) => state.setSort);

  const overwriteMode = useSettingsStore((state) => state.overwriteMode);
  const splitRatio = useUiStore((state) => state.splitRatio);
  const setSplitRatio = useUiStore((state) => state.setSplitRatio);
  const focusedPane = useUiStore((state) => state.focusedPane);
  const setFocusedPane = useUiStore((state) => state.setFocusedPane);
  const openDialog = useUiStore((state) => state.openDialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const setPanel = useUiStore((state) => state.setPanel);

  const openTab = useEditorStore((state) => state.open);
  const applyFetched = useEditorStore((state) => state.applyFetched);

  /**
   * The local pane works with no session at all — browsing your own disk needs
   * no server. When a session exists its path lives in the session store so
   * switching tabs restores where the user was; otherwise it lives in
   * `localPaneStore`, which the sidebar's drive list also writes to.
   */
  const loosePath = useLocalPaneStore((state) => state.path);
  const looseSelection = useLocalPaneStore((state) => state.selection);
  const looseSort = useLocalPaneStore((state) => state.sort);
  const setLoosePath = useLocalPaneStore((state) => state.setPath);
  const setLooseSelection = useLocalPaneStore((state) => state.setSelection);
  const setLooseSort = useLocalPaneStore((state) => state.setSort);

  const localPath = activeId && ui ? ui.localPath : loosePath;
  const localSelection = activeId && ui ? ui.selection.local : looseSelection;
  const localSort = activeId && ui ? ui.sort.local : looseSort;
  const remotePath = ui?.remotePath ?? '/';

  const [reopen, setReopen] = useState<{ tabId: string; name: string; apply: () => void } | null>(
    null,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // ── Split resizing ────────────────────────────────────────────────────────

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (!dragging.current) return;
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width === 0) return;
      setSplitRatio((event.clientX - box.left) / box.width);
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setSplitRatio]);

  const onSplitKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSplitRatio(splitRatio - 0.02);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSplitRatio(splitRatio + 0.02);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSplitRatio(0.5);
    }
  };

  // ── Navigation and selection wiring ───────────────────────────────────────

  const navigateLocal = useCallback(
    (next: string) => {
      if (activeId) setLocalPath(activeId, next);
      else setLoosePath(next);
    },
    [activeId, setLocalPath, setLoosePath],
  );

  const navigateRemote = useCallback(
    (next: string) => {
      if (activeId) setRemotePath(activeId, next);
    },
    [activeId, setRemotePath],
  );

  const selectLocal = useCallback(
    (paths: string[]) => {
      if (activeId) setSelection(activeId, 'local', paths);
      else setLooseSelection(paths);
    },
    [activeId, setSelection, setLooseSelection],
  );

  const selectRemote = useCallback(
    (paths: string[]) => {
      if (activeId) setSelection(activeId, 'remote', paths);
    },
    [activeId, setSelection],
  );

  // ── Transfers ─────────────────────────────────────────────────────────────

  const enqueue = useCallback(
    async (sessionId: string, items: ReturnType<typeof buildEnqueueItems>) => {
      if (items.length === 0) return;
      try {
        const ids = await call<string[]>('enqueue_transfers', {
          request: { sessionId, items },
        });
        setPanel('transfers', true);
        toast({ title: t('transfer.enqueued', { count: ids.length }), variant: 'ok' });
      } catch (error) {
        showError(error, 'transfer.enqueueFailed');
      }
    },
    [setPanel, showError, t, toast],
  );

  /** Names already present at the destination, read fresh so it cannot be stale. */
  const destinationEntries = useCallback(
    async (side: PaneSide, sessionId: string, path: string): Promise<PaneEntry[]> => {
      if (side === 'remote') {
        const files = await call<RemoteFile[]>('list_remote', { sessionId, path });
        return files.map(fromRemoteFile);
      }
      const listing = await call<LocalListing>('list_local', {
        path: path === '' ? null : path,
      });
      return listing.entries.map((entry: LocalFile) => fromLocalFile(entry));
    },
    [],
  );

  /**
   * Move entries from one pane to the other.
   *
   * `overwriteMode: 'ask'` genuinely asks: the destination is listed, collisions
   * are found, and the conflict dialog resolves each one into a concrete policy
   * before anything is enqueued. The old UI defaulted to "ask" and then silently
   * overwrote.
   */
  const transfer = useCallback(
    async (entries: PaneEntry[], from: PaneSide) => {
      if (!activeId || entries.length === 0) return;
      const sessionId = activeId;
      const direction = from === 'local' ? 'upload' : 'download';
      const destinationSide: PaneSide = from === 'local' ? 'remote' : 'local';
      const destinationPath = from === 'local' ? remotePath : localPath;

      const preset = policyForMode(overwriteMode);
      if (preset) {
        await enqueue(
          sessionId,
          buildEnqueueItems({
            entries,
            direction,
            localDir: localPath,
            remoteDir: remotePath,
            policy: preset,
          }),
        );
        return;
      }

      let existing: PaneEntry[];
      try {
        existing = await destinationEntries(destinationSide, sessionId, destinationPath);
      } catch (error) {
        // A destination we cannot read is a destination we must not guess about.
        showError(error, 'transfer.enqueueFailed');
        return;
      }

      const caseInsensitive = isCaseInsensitiveSide(destinationSide, destinationPath);
      const collisions = findConflicts(
        entries,
        existing.map((entry) => entry.name),
        caseInsensitive,
      );

      if (collisions.length === 0) {
        await enqueue(
          sessionId,
          buildEnqueueItems({
            entries,
            direction,
            localDir: localPath,
            remoteDir: remotePath,
            policy: 'overwrite',
          }),
        );
        return;
      }

      const normalize = (name: string) => (caseInsensitive ? name.toLowerCase() : name);
      const byName = new Map(existing.map((entry) => [normalize(entry.name), entry]));
      const conflictEntries: ConflictEntry[] = collisions.map((entry) => {
        const [item] = buildEnqueueItems({
          entries: [entry],
          direction,
          localDir: localPath,
          remoteDir: remotePath,
          policy: 'overwrite',
        });
        const target = byName.get(normalize(entry.name));
        return {
          item: {
            direction: item.direction,
            localPath: item.localPath,
            remotePath: item.remotePath,
            isDir: item.isDir,
          },
          existingSize: target?.isDir ? null : (target?.size ?? null),
          existingModified: target?.modified ?? null,
          incomingSize: entry.isDir ? null : entry.size,
          incomingModified: entry.modified,
        };
      });

      const clean = entries.filter((entry) => !collisions.includes(entry));

      openDialog({
        kind: 'conflict',
        sessionId,
        entries: conflictEntries,
        onResolved: (resolved) => {
          closeDialog();
          const items = [
            ...buildEnqueueItems({
              entries: clean,
              direction,
              localDir: localPath,
              remoteDir: remotePath,
              policy: 'overwrite',
            }),
            ...resolved.map(({ item, policy }) => ({ ...item, onConflict: policy })),
          ];
          void enqueue(sessionId, items);
        },
      });
    },
    [
      activeId,
      closeDialog,
      destinationEntries,
      enqueue,
      localPath,
      openDialog,
      overwriteMode,
      remotePath,
      showError,
    ],
  );

  const runTransfer = useCallback(
    (entries: PaneEntry[], from: PaneSide) => {
      void transfer(entries, from).catch((error: unknown) => {
        showError(error, 'transfer.enqueueFailed');
      });
    },
    [showError, transfer],
  );

  // ── Drops from the OS ─────────────────────────────────────────────────────

  /**
   * Files dropped from the desktop always mean "upload these to the remote
   * folder I am looking at" — a local-to-local drop would be a copy, which the
   * backend has no command for, so pretending to support it would be a lie.
   *
   * The OS gives us paths and nothing else, so each parent directory is listed
   * once to learn which of them are folders. Folders are then handed to the
   * backend with `isDir: true` and expanded there, under its symlink and depth
   * guards.
   */
  const receiveOsDrop = useCallback(
    async (paths: string[]) => {
      if (!activeId || paths.length === 0) return;

      const byParent = new Map<string, Set<string>>();
      for (const dropped of paths) {
        const parent = parentPath(dropped, false);
        if (!parent) continue;
        const names = byParent.get(parent) ?? new Set<string>();
        names.add(baseName(dropped));
        byParent.set(parent, names);
      }

      const entries: PaneEntry[] = [];
      for (const [parent, names] of byParent) {
        try {
          const listing = await call<LocalListing>('list_local', { path: parent });
          for (const entry of listing.entries) {
            if (names.has(entry.name)) entries.push(fromLocalFile(entry));
          }
        } catch {
          // An unreadable parent means those paths are simply skipped; the
          // toast below reports it if nothing at all could be resolved.
        }
      }

      if (entries.length === 0) {
        toast({ title: t('file.dragInvalid'), variant: 'warn' });
        return;
      }
      runTransfer(entries, 'local');
    },
    [activeId, runTransfer, t, toast],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const handle = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== 'drop') return;
          void receiveOsDrop(event.payload.paths);
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not running inside a Tauri webview: pane-to-pane drags still work.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [receiveOsDrop]);

  // ── Opening a remote file in the editor ───────────────────────────────────

  const openInEditor = useCallback(
    (entry: PaneEntry, side: PaneSide) => {
      // There is no local editor: the editor edits files on the server. A local
      // file's "open" therefore means "upload it".
      if (side === 'local' || !activeId) {
        runTransfer([entry], side);
        return;
      }
      setPanel('editor', true);
      void openTab(activeId, entry.path).catch((error: unknown) => {
        if (isReopenConflict(error)) {
          const { tabId, fetched } = error;
          setReopen({
            tabId,
            name: entry.name,
            apply: () => applyFetched(tabId, fetched),
          });
          return;
        }
        if (isAppError(error) && useUiStore.getState().openDialogForError(error, () => {
          void openTab(activeId, entry.path).catch(() => {});
        })) {
          return;
        }
        showError(error);
      });
    },
    [activeId, applyFetched, openTab, runTransfer, setPanel, showError],
  );

  const leftWidth = `${Math.round(splitRatio * 1000) / 10}%`;

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 items-stretch">
      {/*
        `min-h-0` is load-bearing, not decoration: without it a flex child will
        not shrink below its content height, so a long listing pushed this column
        past the container and drew over the transfer queue below.
      */}
      <div style={{ width: leftWidth }} className="flex min-h-0 min-w-0 flex-col">
        <FilePane
          side="local"
          sessionId={activeId}
          path={localPath}
          onNavigate={navigateLocal}
          sort={localSort}
          onSortChange={(next) =>
            activeId ? setSort(activeId, 'local', next) : setLooseSort(next)
          }
          selection={localSelection}
          onSelectionChange={selectLocal}
          focused={focusedPane === 'local'}
          onFocus={() => setFocusedPane('local')}
          onTransfer={(entries) => runTransfer(entries, 'local')}
          onReceive={(entries, from) => runTransfer(entries, from)}
          onOpenFile={(entry) => openInEditor(entry, 'local')}
          onSwitchPane={() => setFocusedPane('remote')}
        />
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('layout.resizePanes')}
        aria-valuenow={Math.round(splitRatio * 100)}
        aria-valuemin={20}
        aria-valuemax={80}
        tabIndex={0}
        onMouseDown={() => {
          dragging.current = true;
        }}
        onKeyDown={onSplitKeyDown}
        className="w-1 shrink-0 cursor-col-resize bg-border transition-quick hover:bg-accent"
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <FilePane
          side="remote"
          sessionId={activeId}
          path={remotePath}
          onNavigate={navigateRemote}
          sort={ui?.sort.remote ?? DEFAULT_SORT}
          onSortChange={(next) => activeId && setSort(activeId, 'remote', next)}
          selection={ui?.selection.remote ?? []}
          onSelectionChange={selectRemote}
          focused={focusedPane === 'remote'}
          onFocus={() => setFocusedPane('remote')}
          onTransfer={(entries) => runTransfer(entries, 'remote')}
          onReceive={(entries, from) => runTransfer(entries, from)}
          onOpenFile={(entry) => openInEditor(entry, 'remote')}
          onSwitchPane={() => setFocusedPane('local')}
        />
      </div>

      <AlertDialog
        open={reopen !== null}
        onOpenChange={(next) => {
          if (!next) setReopen(null);
        }}
        title={t('editor.reopenTitle', { name: reopen?.name ?? '' })}
        description={t('editor.reopenBody')}
        tone="danger"
        confirmLabel={t('editor.reopenReload')}
        cancelLabel={t('editor.reopenKeep')}
        onConfirm={() => {
          reopen?.apply();
          setReopen(null);
        }}
      />
    </div>
  );
}
