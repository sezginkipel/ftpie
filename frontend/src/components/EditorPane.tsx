/* eslint-disable react-refresh/only-export-components */
/**
 * EditorPane — edit remote files in place.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <EditorPane className="min-h-0 flex-1" />
 * ```
 * Everything else comes from `editorStore` (tabs), `settingsStore` (font size,
 * tab width, word wrap) and `uiStore` (the save-conflict dialog). This component
 * also renders `SaveConflictDialog` for `uiStore.dialog.kind === 'saveConflict'`,
 * so the shell must not mount that dialog again.
 *
 * ## Bugs this replaces
 * - **Diff-editor tab corruption.** The old `onMount` captured `activeTab.id`
 *   once and the DiffEditor was never remounted, so switching tabs while the
 *   diff was open wrote the new tab's content into the old tab — and `Ctrl+S`
 *   could then overwrite a remote file with a *different* file's contents. There
 *   is no DiffEditor here at all (comparison lives in `SaveConflictDialog`, from
 *   `editor_diff`), every editor gets `key={tab.id}`, and nothing is ever
 *   written through a captured id: the save handler resolves the active tab from
 *   the store at call time.
 * - **Silent save failures.** They were `console.error` only. Now: a toast, an
 *   inline banner above the editor, and the tab stays dirty.
 * - **`Ctrl+S` re-registered on every keystroke.** Registered once, and it
 *   matches both `s` and `S`.
 * - **Binary corruption.** A binary tab opens read-only with a visible notice;
 *   `editorStore` refuses to save it.
 */
import Editor, { type OnMount } from '@monaco-editor/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '../lib/cn';
import { formatBytes } from '../lib/format';
import { useT } from '../lib/i18n';
import { errorCode } from '../lib/ipc';
import { languageForPath } from '../lib/monaco';
import { useEditorStore, type EditorTab } from '../store/editorStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { SaveConflictDialog } from './SaveConflictDialog';
import {
  AlertDialog,
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  InlineError,
  Spinner,
  Tooltip,
  useToast,
} from './ui';

/**
 * Monaco's built-in light/dark themes, following the app's theme preference.
 * Exported because `ScriptManager` needs exactly the same behaviour.
 */
export function useMonacoTheme(): 'vs' | 'vs-dark' {
  const preference = useSettingsStore((s) => s.theme);
  const [systemDark, setSystemDark] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const handle = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', handle);
    return () => query.removeEventListener('change', handle);
  }, []);

  const dark = preference === 'dark' || (preference === 'system' && systemDark);
  return dark ? 'vs-dark' : 'vs';
}

export interface EditorPaneProps {
  className?: string;
}

export function EditorPane({ className }: EditorPaneProps) {
  const { t } = useT();
  const { toast, showError } = useToast();

  const tabs = useEditorStore((s) => s.tabs);
  const activeId = useEditorStore((s) => s.activeId);
  const active = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [tabs, activeId],
  );

  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const tabSize = useSettingsStore((s) => s.editorTabSize);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const monacoTheme = useMonacoTheme();

  const dialog = useUiStore((s) => s.dialog);
  const openDialog = useUiStore((s) => s.openDialog);
  const closeDialog = useUiStore((s) => s.closeDialog);

  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [pendingClose, setPendingClose] = useState<EditorTab | null>(null);

  /**
   * Save whichever tab is active *right now*. Resolving from the store instead
   * of from a captured value is what keeps a stale id from writing over the
   * wrong remote file.
   */
  const saveTab = useCallback(
    async (tabId: string) => {
      const store = useEditorStore.getState();
      const tab = store.byId(tabId);
      if (!tab || tab.isBinary || !tab.dirty || tab.saving) return;

      try {
        await store.save(tabId);
        toast({ title: t('editor.saved', { name: tab.fileName }), variant: 'ok' });
      } catch (error) {
        if (errorCode(error) === 'conflict') {
          openDialog({
            kind: 'saveConflict',
            tabId,
            remoteHash:
              typeof (error as { remoteHash?: string | null }).remoteHash === 'string'
                ? (error as { remoteHash: string }).remoteHash
                : null,
            diff: null,
            remote: null,
          });
          return;
        }
        showError(error, 'editor.saveFailed');
      }
    },
    [openDialog, showError, t, toast],
  );

  // Registered exactly once. The old version rebuilt this listener on every
  // keystroke because `activeTab` was in its dependency array.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key !== 's' && event.key !== 'S') return;
      const id = useEditorStore.getState().activeId;
      if (!id) return;
      event.preventDefault();
      void saveTab(id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [saveTab]);

  const requestClose = useCallback((tab: EditorTab) => {
    if (tab.dirty) {
      setPendingClose(tab);
      return;
    }
    useEditorStore.getState().close(tab.id);
  }, []);

  const onMount = useCallback<OnMount>((editor) => {
    setPosition({ line: 1, column: 1 });
    const subscription = editor.onDidChangeCursorPosition((event) => {
      setPosition({ line: event.position.lineNumber, column: event.position.column });
    });
    // Monaco disposes model listeners with the instance, but the subscription is
    // ours and is released explicitly when this editor unmounts.
    editor.onDidDispose(() => subscription.dispose());
  }, []);

  const language = active ? languageForPath(active.remotePath) : 'plaintext';

  return (
    <section
      className={cn('flex min-h-0 flex-col bg-surface', className)}
      aria-label={t('editor.title')}
    >
      {tabs.length === 0 ? (
        <EmptyState
          icon="file-text"
          title={t('editor.empty')}
          description={t('editor.emptyHint')}
        />
      ) : (
        <>
          {/* ── Tab bar ── */}
          <div
            role="tablist"
            aria-label={t('editor.tabList')}
            className="flex h-8 flex-none items-stretch overflow-x-auto border-b border-border"
          >
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  'flex flex-none items-center gap-1.5 border-r border-border px-2 text-base',
                  tab.id === activeId ? 'bg-surface-2 text-text' : 'text-text-2',
                )}
                // Middle-click closes, matching every editor people already use.
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    requestClose(tab);
                  }
                }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeId}
                  onClick={() => useEditorStore.getState().setActive(tab.id)}
                  className="flex max-w-[200px] items-center gap-1.5 truncate rounded"
                >
                  <Icon name={tab.isBinary ? 'file-binary' : 'file-text'} />
                  <span className="truncate">{tab.fileName}</span>
                  {tab.saving ? <Spinner /> : null}
                  {tab.dirty ? (
                    <span
                      aria-label={t('editor.dirty')}
                      title={t('editor.dirty')}
                      className="h-1.5 w-1.5 flex-none rounded-full bg-warn"
                    />
                  ) : null}
                </button>
                <IconButton
                  label={t('editor.closeTab', { name: tab.fileName })}
                  icon={<Icon name="x" />}
                  onClick={() => requestClose(tab)}
                />
              </div>
            ))}
          </div>

          {active ? (
            <>
              {active.isBinary ? (
                <p
                  role="note"
                  className="flex flex-none items-center gap-1.5 border-b border-border bg-surface-2 px-2 py-1 text-sm text-warn"
                >
                  <Icon name="alert-triangle" />
                  <strong className="font-semibold">{t('editor.binaryTitle')}</strong>
                  <span className="text-text-2">{t('editor.binaryBody')}</span>
                </p>
              ) : null}

              {active.saveError ? (
                <div className="flex-none border-b border-danger bg-surface-2 px-2 py-1">
                  <p className="text-sm font-semibold text-danger">
                    {t('editor.saveBannerTitle')}
                  </p>
                  <InlineError error={active.saveError} />
                </div>
              ) : null}

              <div className="min-h-0 flex-1">
                <Editor
                  // The key is the whole fix for the old cross-tab write: a new
                  // tab means a new editor instance and a new model.
                  key={active.id}
                  language={language}
                  value={active.content}
                  theme={monacoTheme}
                  onMount={onMount}
                  onChange={(value) => {
                    if (active.isBinary) return;
                    useEditorStore.getState().setContent(active.id, value ?? '');
                  }}
                  options={{
                    readOnly: active.isBinary,
                    fontSize,
                    tabSize,
                    wordWrap: wordWrap ? 'on' : 'off',
                    fontFamily: 'var(--font-mono)',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    renderWhitespace: 'selection',
                    automaticLayout: true,
                  }}
                />
              </div>

              {/* ── Status line ── */}
              <div className="flex h-statusbar flex-none items-center gap-3 border-t border-border px-2 text-xs text-text-2">
                <Tooltip content={active.remotePath} mono>
                  <span className="min-w-0 max-w-[40%] truncate font-mono">
                    {active.remotePath}
                  </span>
                </Tooltip>
                <span className="tnum">
                  {t('editor.lineCol', { line: position.line, column: position.column })}
                </span>
                <span>{language}</span>
                <span className="uppercase">{active.encoding}</span>
                <span className="tnum">
                  {t('editor.bytesOnServer', { size: formatBytes(active.size) })}
                </span>
                {active.isBinary ? (
                  <Badge tone="warn">{t('editor.readOnly')}</Badge>
                ) : null}
                {active.dirty ? <Badge tone="warn">{t('editor.dirty')}</Badge> : null}
                <span className="flex-1" />
                <span className="text-text-3">{t('editor.middleClickHint')}</span>
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Icon name="save" />}
                  disabled={active.isBinary || !active.dirty}
                  loading={active.saving}
                  onClick={() => void saveTab(active.id)}
                >
                  {t('common.save')}
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}

      <AlertDialog
        open={pendingClose !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClose(null);
        }}
        title={t('editor.closeDirtyTitle')}
        description={t('editor.closeDirtyBody', { name: pendingClose?.fileName ?? '' })}
        confirmLabel={t('editor.closeDiscard')}
        onConfirm={() => {
          if (pendingClose) useEditorStore.getState().close(pendingClose.id);
          setPendingClose(null);
        }}
      />

      {dialog.kind === 'saveConflict' ? (
        <SaveConflictDialog
          tabId={dialog.tabId}
          remoteHash={dialog.remoteHash}
          onClose={closeDialog}
        />
      ) : null}
    </section>
  );
}
