/**
 * Bookmarks and places.
 *
 * Changes from the old sidebar: bookmarks are searchable and grouped by tag,
 * every row is a real focusable control with a context menu, drives come from
 * `list_drives`, export/import are wired up (the commands existed and were
 * never called), failures render an `ErrorState` instead of an empty list, and
 * the dead "Git: No repository" block is gone — the deploy panel owns that.
 *
 * When `app_version` reports `stores.bookmarksOk === false` the bookmark file
 * was quarantined and loaded empty **and read-only**. That is stated at the top,
 * loudly, because otherwise the user's bookmarks simply appear to have vanished.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import { useT } from '../lib/i18n';
import { call, isAppError } from '../lib/ipc';
import type { Bookmark, DriveInfo } from '../lib/types';
import { hasStoredPassword } from '../lib/types';
import { useBookmarkStore } from '../store/bookmarkStore';
import { useSessionStore } from '../store/sessionStore';
import { useUiStore } from '../store/uiStore';
import { navigateLocalPane } from './FileBrowser/localPane';
import {
  AlertDialog,
  Button,
  ContextMenu,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  InlineError,
  Input,
  Spinner,
  Textarea,
  Tooltip,
  useToast,
  type MenuItem,
} from './ui';
import { APP_INFO_QUERY_KEY, type AppInfoFull } from './StatusBar';

export function Sidebar() {
  const { t } = useT();
  const { toast, showError } = useToast();

  const bookmarks = useBookmarkStore((state) => state.bookmarks);
  const loading = useBookmarkStore((state) => state.loading);
  const loadError = useBookmarkStore((state) => state.error);
  const load = useBookmarkStore((state) => state.load);
  const remove = useBookmarkStore((state) => state.remove);
  const duplicate = useBookmarkStore((state) => state.duplicate);
  const byTag = useBookmarkStore((state) => state.byTag);
  const search = useBookmarkStore((state) => state.search);

  const connectBookmark = useSessionStore((state) => state.connectBookmark);
  const openDialog = useUiStore((state) => state.openDialog);
  const openDialogForError = useUiStore((state) => state.openDialogForError);

  const [query, setQuery] = useState('');
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Bookmark | null>(null);

  useEffect(() => {
    void load().catch(() => {
      // The store records the error; the ErrorState below renders it.
    });
  }, [load]);

  const appInfo = useQuery<AppInfoFull, unknown>({
    queryKey: APP_INFO_QUERY_KEY,
    queryFn: () => call<AppInfoFull>('app_version'),
    retry: false,
    staleTime: Infinity,
  });

  const drives = useQuery<DriveInfo[], unknown>({
    queryKey: ['drives'],
    queryFn: () => call<DriveInfo[]>('list_drives'),
    retry: false,
    staleTime: 60_000,
  });

  const bookmarksReadOnly = appInfo.data?.stores.bookmarksOk === false;

  const connect = (bookmark: Bookmark) => {
    setConnecting(bookmark.id);
    connectBookmark(bookmark.id)
      .then(() => setConnecting(null))
      .catch((error: unknown) => {
        setConnecting(null);
        if (isAppError(error) && openDialogForError(error, () => connect(bookmark))) return;
        showError(error, 'bookmark.connectFailed');
      });
  };

  const menuFor = (bookmark: Bookmark): MenuItem[] => [
    {
      id: 'connect',
      label: t('common.connect'),
      icon: <Icon name="play" />,
      onSelect: () => connect(bookmark),
    },
    {
      id: 'edit',
      label: t('bookmark.editTitle'),
      icon: <Icon name="edit" />,
      disabled: bookmarksReadOnly,
      onSelect: () => openDialog({ kind: 'connection', bookmark, editing: true }),
    },
    {
      id: 'duplicate',
      label: t('common.duplicate'),
      icon: <Icon name="copy" />,
      disabled: bookmarksReadOnly,
      onSelect: () => {
        void duplicate(bookmark.id, `${bookmark.name} (2)`)
          .then(() => toast({ title: t('bookmark.saved'), variant: 'ok' }))
          .catch((error: unknown) => showError(error));
      },
    },
    { kind: 'separator', id: 'sep' },
    {
      id: 'delete',
      label: t('common.delete'),
      icon: <Icon name="trash" />,
      danger: true,
      disabled: bookmarksReadOnly,
      onSelect: () => setPendingDelete(bookmark),
    },
  ];

  const filtered = query.trim() === '' ? null : search(query);
  const groups = byTag();

  return (
    <aside
      aria-label={t('bookmark.title')}
      className="flex w-[220px] shrink-0 flex-col overflow-hidden border-r border-border bg-surface"
    >
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <Icon name="bookmark" className="text-text-3" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-text-2">
          {t('bookmark.title')}
        </span>
        <IconButton
          label={t('common.export')}
          icon={<Icon name="upload" />}
          size="sm"
          variant="ghost"
          onClick={() => openDialog({ kind: 'bookmarkExport' })}
        />
        <IconButton
          label={t('common.import')}
          icon={<Icon name="download" />}
          size="sm"
          variant="ghost"
          disabled={bookmarksReadOnly}
          onClick={() => openDialog({ kind: 'bookmarkImport' })}
        />
      </div>

      {bookmarksReadOnly ? (
        <div className="m-2 flex flex-col gap-1 rounded border border-[var(--warn)] bg-surface-2 p-2">
          <span className="flex items-center gap-1 text-sm font-semibold text-warn">
            <Icon name="alert-triangle" />
            {t('vault.quarantinedTitle')}
          </span>
          <p className="text-xs text-text-2">{t('vault.quarantinedBody')}</p>
        </div>
      ) : null}

      <div className="px-2 py-1.5">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('bookmark.search')}
          aria-label={t('bookmark.search')}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadError && bookmarks.length === 0 ? (
          <ErrorState
            error={loadError}
            compact
            onRetry={() => {
              void load().catch(() => {});
            }}
          />
        ) : loading && bookmarks.length === 0 ? (
          <div className="flex justify-center p-4">
            <Spinner label={t('common.loading')} />
          </div>
        ) : bookmarks.length === 0 ? (
          <EmptyState
            compact
            icon="bookmark"
            title={t('bookmark.empty')}
            description={t('bookmark.emptyHint')}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => openDialog({ kind: 'connection' })}
              >
                {t('app.newConnection')}
              </Button>
            }
          />
        ) : filtered ? (
          filtered.length === 0 ? (
            <EmptyState
              compact
              icon="search"
              title={t('state.noResults')}
              description={t('state.noResultsHint', { query })}
            />
          ) : (
            <ul className="py-1">
              {filtered.map((bookmark) => (
                <BookmarkRow
                  key={bookmark.id}
                  bookmark={bookmark}
                  busy={connecting === bookmark.id}
                  items={menuFor(bookmark)}
                  onConnect={() => connect(bookmark)}
                />
              ))}
            </ul>
          )
        ) : (
          groups.map((group) => (
            <section key={group.tag || 'untagged'} className="py-1">
              <h2 className="px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-text-3">
                {group.tag === '' ? t('bookmark.untagged') : group.tag}
              </h2>
              <ul>
                {group.bookmarks.map((bookmark) => (
                  <BookmarkRow
                    key={`${group.tag}:${bookmark.id}`}
                    bookmark={bookmark}
                    busy={connecting === bookmark.id}
                    items={menuFor(bookmark)}
                    onConnect={() => connect(bookmark)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border">
        <h2 className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-text-3">
          {t('places.title')}
        </h2>
        {drives.isError ? (
          <ErrorState
            error={drives.error}
            compact
            onRetry={() => void drives.refetch()}
          />
        ) : (
          <ul className="max-h-40 overflow-y-auto pb-1">
            {(drives.data ?? []).map((drive) => (
              <li key={drive.path}>
                <button
                  type="button"
                  onClick={() => navigateLocalPane(drive.path)}
                  title={drive.path}
                  className="row w-full gap-1.5 px-2 text-left transition-quick hover:bg-surface-2"
                >
                  <Icon name="drive" className="text-text-3" />
                  <span className="cell-truncate text-sm">{drive.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        title={t('bookmark.deleteTitle')}
        description={t('bookmark.deleteBody', { name: pendingDelete?.name ?? '' })}
        tone="danger"
        confirmLabel={t('delete.confirmOne', { name: pendingDelete?.name ?? '' })}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (!target) return;
          void remove(target.id).catch((error: unknown) => showError(error));
        }}
      />

      <BookmarkExportDialog />
      <BookmarkImportDialog />
    </aside>
  );
}

interface BookmarkRowProps {
  bookmark: Bookmark;
  busy: boolean;
  items: MenuItem[];
  onConnect: () => void;
}

function BookmarkRow({ bookmark, busy, items, onConnect }: BookmarkRowProps) {
  const { t } = useT();

  return (
    <li>
      <ContextMenu items={items} label={bookmark.name}>
        <div className="group flex items-center">
          <button
            type="button"
            onClick={onConnect}
            title={`${bookmark.username}@${bookmark.host}:${bookmark.port}`}
            className={cn(
              'row min-w-0 flex-1 gap-1.5 px-2 text-left transition-quick hover:bg-surface-2',
            )}
          >
            {busy ? (
              <Spinner label={t('conn.connecting')} />
            ) : (
              <Icon
                name={bookmark.protocol === 'ftp' ? 'unlock' : 'lock'}
                className={bookmark.protocol === 'ftp' ? 'text-danger' : 'text-text-3'}
              />
            )}
            <span className="cell-truncate min-w-0 flex-1 text-sm">{bookmark.name}</span>
            {hasStoredPassword(bookmark) ? (
              <Tooltip content={t('bookmark.hasPassword')}>
                <span className="text-text-3">
                  <Icon name="key" />
                </span>
              </Tooltip>
            ) : null}
          </button>
        </div>
      </ContextMenu>
    </li>
  );
}

/** Export every bookmark into an encrypted archive the user can save anywhere. */
function BookmarkExportDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const exportAll = useBookmarkStore((state) => state.exportAll);
  const { t } = useT();
  const { toast } = useToast();

  const [passphrase, setPassphrase] = useState('');
  const [archive, setArchive] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = dialog.kind === 'bookmarkExport';
  useEffect(() => {
    if (!open) return;
    setPassphrase('');
    setArchive('');
    setError(null);
  }, [open]);

  if (!open) return null;

  const tooShort = passphrase.length > 0 && passphrase.length < 8;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setArchive(await exportAll(passphrase));
      toast({ title: t('bookmark.exported'), variant: 'ok' });
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={t('bookmark.exportTitle')}
      size="md"
      footer={
        <>
          <InlineError error={error} className="mr-auto" />
          <Button variant="secondary" onClick={closeDialog}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={passphrase.length < 8}
            onClick={() => void run()}
          >
            {t('common.export')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-base text-text-2">{t('bookmark.exportBody')}</p>
        <Field
          label={t('bookmark.exportPassphrase')}
          hint={t('bookmark.exportPassphraseHint')}
          error={tooShort ? t('vault.tooShort', { min: 8 }) : null}
          required
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          )}
        </Field>
        {archive !== '' ? (
          <Field label={t('common.export')}>
            {({ id }) => (
              <Textarea id={id} mono readOnly rows={6} value={archive} />
            )}
          </Field>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Restore bookmarks from an exported archive. */
function BookmarkImportDialog() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const importArchive = useBookmarkStore((state) => state.importArchive);
  const { t } = useT();
  const { toast } = useToast();

  const [passphrase, setPassphrase] = useState('');
  const [archive, setArchive] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = dialog.kind === 'bookmarkImport';
  useEffect(() => {
    if (!open) return;
    setPassphrase('');
    setArchive('');
    setError(null);
  }, [open]);

  if (!open) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const report = await importArchive(archive, passphrase);
      toast({
        title: t('bookmark.imported', { added: report.added, skipped: report.skipped }),
        description:
          report.idsRegenerated > 0
            ? t('bookmark.importedRenumbered', { count: report.idsRegenerated })
            : undefined,
        variant: 'ok',
      });
      closeDialog();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
      title={t('bookmark.importTitle')}
      size="md"
      footer={
        <>
          <InlineError error={error} className="mr-auto" />
          <Button variant="secondary" onClick={closeDialog}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={archive.trim() === '' || passphrase === ''}
            onClick={() => void run()}
          >
            {t('common.import')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-base text-text-2">{t('bookmark.importBody')}</p>
        <Field label={t('bookmark.exportPassphrase')} required>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('common.import')} required>
          {({ id }) => (
            <Textarea
              id={id}
              mono
              rows={6}
              value={archive}
              onChange={(event) => setArchive(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
