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
  const active = useMemo(() => tabs.find((tab) => tab.id === activeId) ?? null, [tabs, activeId]);

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
          {/*
           * Tab strip. This is chrome, so it sits a surface step above the
           * editor and the selected tab is cut out of it — lit, flush with the
           * text below, and marked with an accent rail along its top edge. That
           * reads as an editor; a row of equal-weight buttons reads as a form.
           */}
          <div
            role="tablist"
            aria-label={t('editor.tabList')}
            className="flex h-9 flex-none items-stretch overflow-x-auto border-b border-border bg-surface-2"
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeId;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group relative flex flex-none items-center gap-1.5 border-r border-border pl-2.5 pr-1 text-base transition-quick',
                    selected
                      ? 'bg-surface text-text'
                      : 'text-text-2 hover:bg-surface hover:text-text',
                  )}
                  // Middle-click closes, matching every editor people already use.
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      requestClose(tab);
                    }
                  }}
                >
                  {selected ? (
                    <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5 bg-accent" />
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => useEditorStore.getState().setActive(tab.id)}
                    className="flex max-w-[220px] items-center gap-1.5 truncate rounded-sm py-1"
                  >
                    <Icon
                      name={tab.isBinary ? 'file-binary' : 'file-text'}
                      className={cn(
                        'flex-none',
                        tab.isBinary ? 'text-warn' : selected ? 'text-accent' : 'text-text-3',
                      )}
                    />
                    <span className={cn('truncate', tab.dirty && 'italic')}>{tab.fileName}</span>
                    {tab.saving ? <Spinner /> : null}
                    {tab.dirty && !tab.saving ? (
                      <span
                        aria-label={t('editor.dirty')}
                        title={t('editor.dirty')}
                        className="h-1.5 w-1.5 flex-none rounded-full bg-warn shadow-[0_0_0_2px_var(--warn-weak)]"
                      />
                    ) : null}
                  </button>
                  <IconButton
                    label={t('editor.closeTab', { name: tab.fileName })}
                    icon={<Icon name="x" />}
                    className={cn(
                      'press transition-quick focus-visible:opacity-100 group-hover:opacity-100',
                      selected ? 'opacity-100' : 'opacity-0',
                    )}
                    onClick={() => requestClose(tab)}
                  />
                </div>
              );
            })}
          </div>

          {active ? (
            <>
              {active.isBinary ? (
                <p
                  role="note"
                  className="flex flex-none items-center gap-2 border-b border-border bg-warn-weak px-3 py-1.5 text-sm"
                >
                  <Icon name="alert-triangle" className="flex-none text-warn" />
                  <strong className="font-semibold text-text">{t('editor.binaryTitle')}</strong>
                  <span className="min-w-0 truncate text-text-2">{t('editor.binaryBody')}</span>
                </p>
              ) : null}

              {/*
               * A save that failed is the one thing in this pane that must not
               * be missable: a full-width tinted band, its own icon, and the
               * backend reason spelled out underneath.
               */}
              {active.saveError ? (
                <div className="flex flex-none items-start gap-2.5 border-b border-[var(--danger)] bg-surface-2 px-3 py-2 shadow-e1">
                  <Icon name="alert-circle" size={16} className="mt-0.5 flex-none text-danger" />
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-semibold tracking-tight text-danger">
                      {t('editor.saveBannerTitle')}
                    </p>
                    <InlineError error={active.saveError} className="mt-1.5" />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="press"
                    icon={<Icon name="save" />}
                    loading={active.saving}
                    onClick={() => void saveTab(active.id)}
                  >
                    {t('common.retry')}
                  </Button>
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

              {/*
               * Status line. Quieter than the tab strip above it: metadata is
               * grouped, separated by hairlines instead of by whitespace, and
               * every number is tabular so nothing jitters as you type.
               */}
              <div
                aria-label={t('editor.statusLine')}
                className="flex h-8 flex-none items-center gap-2.5 border-t border-border bg-surface-2 px-2 text-xs text-text-2"
              >
                <Tooltip content={active.remotePath} mono>
                  <span className="min-w-0 max-w-[40%] truncate font-mono text-text-3">
                    {active.remotePath}
                  </span>
                </Tooltip>

                <span aria-hidden="true" className="h-3.5 w-px flex-none bg-border" />

                <span className="flex-none tnum">
                  {t('editor.lineCol', { line: position.line, column: position.column })}
                </span>
                <span className="flex-none font-mono text-text-3">{language}</span>
                <span className="flex-none uppercase tracking-wide text-text-3">
                  {active.encoding}
                </span>
                <span className="flex-none tnum text-text-3">
                  {t('editor.bytesOnServer', { size: formatBytes(active.size) })}
                </span>

                {active.isBinary ? (
                  <span className="flex-none rounded-sm bg-warn-weak px-1.5 py-px text-2xs uppercase tracking-wider text-warn">
                    {t('editor.readOnly')}
                  </span>
                ) : null}
                {active.dirty ? (
                  <span className="flex-none rounded-sm bg-warn-weak px-1.5 py-px text-2xs uppercase tracking-wider text-warn">
                    {t('editor.dirty')}
                  </span>
                ) : null}

                <span className="flex-1" />
                <span className="hidden flex-none text-text-3 lg:inline">
                  {t('editor.middleClickHint')}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  className="press"
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
