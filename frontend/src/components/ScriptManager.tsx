/**
 * ScriptManager — write, check, and run Rhai automation scripts.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <ScriptManager
 *   open={dialog.kind === 'scripts'}
 *   onOpenChange={(open) => (open ? undefined : closeDialog())}
 *   initialScriptId={dialog.kind === 'scripts' ? dialog.scriptId : null}
 * />
 * ```
 *
 * ## What changed
 * - The editor is the **Rhai** language from the local Monaco bundle. It used to
 *   be `javascript`, which highlighted the wrong keywords and had the TypeScript
 *   worker draw squiggles under perfectly valid Rhai.
 * - **Every backend call is wrapped.** `loadScripts`, `save`, `newScript`,
 *   `deleteScript` and `validate` previously had no error handling at all, so
 *   any failure was an unhandled rejection and the dialog froze.
 * - A run gets a caller-generated `runId`, so Stop actually stops it via
 *   `cancel_script`.
 * - The dialog is responsive instead of a fixed 900×600 that overflowed small
 *   windows.
 *
 * `run_script` returns its `logs` with the finished `ScriptRun` — the backend
 * does not stream them — so the output panel says that rather than pretending to
 * be a live console.
 */
import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { formatDate, formatEta } from '../lib/format';
import { errorDetail, useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import { RHAI_LANGUAGE_ID } from '../lib/monaco';
import {
  SCRIPT_HOST_FUNCTIONS,
  type RunScriptArgs,
  type SaveScriptArgs,
  type Script,
  type ScriptRun,
} from '../lib/types';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useMonacoTheme } from './EditorPane';
import {
  AlertDialog,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  Spinner,
  useToast,
} from './ui';

const NEW_SCRIPT_SOURCE = `// ${'ftpie'} — Rhai
let files = ftp_list("/");
for f in files {
    log(f);
}
`;

interface Draft {
  id: string | null;
  name: string;
  description: string;
  source: string;
}

const EMPTY_DRAFT: Draft = { id: null, name: '', description: '', source: NEW_SCRIPT_SOURCE };

function draftFrom(script: Script): Draft {
  return {
    id: script.id,
    name: script.name,
    description: script.description,
    source: script.source,
  };
}

export interface ScriptManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialScriptId?: string | null;
}

export function ScriptManager({ open, onOpenChange, initialScriptId }: ScriptManagerProps) {
  const { t, locale } = useT();
  const { toast, showError } = useToast();

  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const fontSize = useSettingsStore((s) => s.editorFontSize);
  const tabSize = useSettingsStore((s) => s.editorTabSize);
  const wordWrap = useSettingsStore((s) => s.editorWordWrap);
  const monacoTheme = useMonacoTheme();

  /**
   * Select the two stable references and derive the list here.
   *
   * A selector like `s.order.map((id) => s.sessions[id])` builds a fresh array on
   * every store read, and zustand v5 compares snapshots by reference — so it
   * re-rendered forever ("Maximum update depth exceeded") the moment this
   * component mounted, which is at app start because the dialog host renders it
   * with `open={false}`.
   */
  const sessionOrder = useSessionStore((s) => s.order);
  const sessionMap = useSessionStore((s) => s.sessions);
  const sessions = useMemo(
    () => sessionOrder.map((id) => sessionMap[id]).filter((s) => s !== undefined),
    [sessionOrder, sessionMap],
  );
  const activeSessionId = useSessionStore((s) => s.activeId);

  const [scripts, setScripts] = useState<Script[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; detail: string | null } | null>(null);
  const [validating, setValidating] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<ScriptRun | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [sessionChoice, setSessionChoice] = useState<string>('');
  const [deleting, setDeleting] = useState<Script | null>(null);

  useEffect(() => {
    if (open) setSessionChoice((current) => current || activeSessionId || '');
  }, [activeSessionId, open]);

  const load = useCallback(async () => {
    setListError(null);
    try {
      setScripts(await call<Script[]>('list_scripts'));
    } catch (error) {
      setScripts(null);
      setListError(error);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [load, open]);

  // Honour a preselected script once the list arrives.
  useEffect(() => {
    if (!open || !initialScriptId || !scripts) return;
    const found = scripts.find((script) => script.id === initialScriptId);
    if (found) setDraft(draftFrom(found));
  }, [initialScriptId, open, scripts]);

  const selected = useMemo(
    () => scripts?.find((script) => script.id === draft.id) ?? null,
    [draft.id, scripts],
  );

  const nameError = draft.name.trim() === '' ? t('script.nameRequired') : null;

  const save = useCallback(async () => {
    if (nameError) return;
    setSaving(true);
    try {
      const args: SaveScriptArgs = {
        id: draft.id,
        name: draft.name.trim(),
        description: draft.description.trim(),
        source: draft.source,
      };
      const saved = await call<Script>('save_script', { args });
      setDraft(draftFrom(saved));
      toast({ title: t('script.saved'), variant: 'ok' });
      await load();
    } catch (error) {
      showError(error, 'script.saveFailed');
    } finally {
      setSaving(false);
    }
  }, [draft, load, nameError, showError, t, toast]);

  const remove = useCallback(
    async (script: Script) => {
      try {
        await call<void>('delete_script', { id: script.id });
        toast({ title: t('script.deleted'), variant: 'ok' });
        if (draft.id === script.id) setDraft(EMPTY_DRAFT);
        await load();
      } catch (error) {
        showError(error, 'script.deleteFailed');
      } finally {
        setDeleting(null);
      }
    },
    [draft.id, load, showError, t, toast],
  );

  const validate = useCallback(async () => {
    setValidating(true);
    setValidation(null);
    try {
      await call<void>('validate_script', { source: draft.source });
      setValidation({ ok: true, detail: null });
    } catch (error) {
      // A parse error is expected output here, not an incident — it goes inline
      // rather than into a toast.
      setValidation({ ok: false, detail: errorDetail(error) });
    } finally {
      setValidating(false);
    }
  }, [draft.source]);

  const start = useCallback(async () => {
    const id = crypto.randomUUID();
    setRunId(id);
    setRun(null);
    setRunError(null);
    try {
      const args: RunScriptArgs = {
        runId: id,
        sessionId: sessionChoice === '' ? null : sessionChoice,
        // A saved-and-unchanged script runs by id; anything edited runs from the
        // buffer, so what you see is what executes.
        scriptId: selected && selected.source === draft.source ? selected.id : null,
        source: selected && selected.source === draft.source ? null : draft.source,
      };
      const result = await call<ScriptRun>('run_script', { args });
      setRun(result);
      toast({
        title: t('script.runSucceeded', { duration: formatEta(result.durationMs / 1000) }),
        variant: 'ok',
      });
      await load();
    } catch (error) {
      setRunError(error);
      showError(error, 'script.runFailed');
    } finally {
      setRunId(null);
    }
  }, [draft.source, load, selected, sessionChoice, showError, t, toast]);

  const stop = useCallback(async () => {
    if (!runId) return;
    try {
      await call<void>('cancel_script', { runId });
      toast({ title: t('script.cancelled'), variant: 'warn' });
    } catch (error) {
      showError(error);
    }
  }, [runId, showError, t, toast]);

  const sessionOptions = useMemo(
    () => [
      { value: '', label: t('script.noSession') },
      ...sessions
        .filter((meta): meta is NonNullable<typeof meta> => Boolean(meta))
        .map((meta) => ({
          value: meta.id,
          label: `${meta.username}@${meta.host}`,
        })),
    ],
    [sessions, t],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={t('script.title')}
      description={t('script.emptyHint')}
      className="h-[85vh]"
      footer={
        <div className="flex w-full items-center gap-2">
          <Select
            value={sessionChoice}
            onValueChange={setSessionChoice}
            options={sessionOptions}
            aria-label={t('script.session')}
            className="max-w-[220px]"
          />
          <span className="flex-1" />
          <Button
            className="press"
            icon={<Icon name="check" />}
            loading={validating}
            onClick={() => void validate()}
          >
            {t('script.validate')}
          </Button>
          {runId ? (
            <Button
              variant="danger"
              className="press"
              icon={<Icon name="stop" />}
              onClick={() => void stop()}
            >
              {t('script.cancel')}
            </Button>
          ) : (
            <Button
              variant="primary"
              className="press"
              icon={<Icon name="play" />}
              disabled={draft.source.trim() === ''}
              onClick={() => void start()}
            >
              {t('script.run')}
            </Button>
          )}
          <Button
            className="press"
            icon={<Icon name="save" />}
            loading={saving}
            disabled={nameError !== null}
            onClick={() => void save()}
          >
            {t('script.save')}
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 gap-2.5">
        {/* ── Saved scripts ── */}
        <div className="flex w-48 flex-none flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-e1">
          <div className="flex h-8 flex-none items-center gap-1 border-b border-border bg-surface-2 px-2">
            <span className="flex-1 text-2xs uppercase tracking-wider text-text-3">
              {t('script.list')}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="press"
              icon={<Icon name="plus" />}
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setValidation(null);
                setRun(null);
              }}
            >
              {t('script.new')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {listError ? (
              <ErrorState
                error={listError}
                title={t('script.loadFailed')}
                compact
                onRetry={() => void load()}
              />
            ) : scripts === null ? (
              <p className="flex items-center gap-1.5 p-2 text-sm text-text-3">
                <Spinner /> {t('common.loading')}
              </p>
            ) : scripts.length === 0 ? (
              <EmptyState icon="terminal" title={t('script.empty')} compact />
            ) : (
              <ul>
                {scripts.map((script) => (
                  <li
                    key={script.id}
                    className="group flex items-center gap-1 border-b border-border last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(draftFrom(script));
                        setValidation(null);
                        setRun(null);
                        setRunError(null);
                      }}
                      aria-current={script.id === draft.id}
                      // The selected row gets the accent fill plus a 2px inset
                      // rail, which is the app-wide selection treatment.
                      className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-base transition-quick hover:bg-surface-2 aria-[current=true]:bg-accent-weak aria-[current=true]:shadow-[inset_2px_0_0_0_var(--accent)]"
                    >
                      <span className="block truncate text-text">{script.name}</span>
                      <span className="block truncate text-xs tnum text-text-3">
                        {script.lastRun
                          ? `${t('script.lastRun')}: ${formatDate(script.lastRun, locale, dateFormat)}`
                          : t('script.neverRun')}
                      </span>
                    </button>
                    <IconButton
                      className="press mr-1 opacity-0 transition-quick focus-visible:opacity-100 group-hover:opacity-100"
                      icon={<Icon name="trash" />}
                      label={t('common.delete')}
                      variant="danger"
                      onClick={() => setDeleting(script)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ── Editor + output ── */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="grid flex-none gap-2 sm:grid-cols-2">
            <Field label={t('script.name')} error={nameError} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder={t('script.unsavedBuffer')}
                />
              )}
            </Field>
            <Field label={t('script.description')}>
              {({ id }) => (
                <Input
                  id={id}
                  value={draft.description}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, description: event.target.value }))
                  }
                />
              )}
            </Field>
          </div>

          {/*
           * The source panel is framed like an editor, not like a form control:
           * its own chrome strip naming the language, with the editor flush to
           * the frame underneath.
           */}
          <div className="flex min-h-[180px] flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-e1">
            <div className="flex h-7 flex-none items-center gap-2 border-b border-border bg-surface-2 px-2">
              <Icon name="terminal" className="flex-none text-text-3" />
              <span className="text-2xs uppercase tracking-wider text-text-3">
                {t('script.sourceSection')}
              </span>
              <span className="flex-1" />
              <span className="font-mono text-2xs uppercase tracking-wider text-text-3">
                {t('script.language')}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <Editor
                language={RHAI_LANGUAGE_ID}
                value={draft.source}
                theme={monacoTheme}
                onChange={(value) => setDraft((current) => ({ ...current, source: value ?? '' }))}
                options={{
                  fontSize,
                  tabSize,
                  wordWrap: wordWrap ? 'on' : 'off',
                  fontFamily: 'var(--font-mono)',
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  ariaLabel: t('script.editorLabel'),
                }}
              />
            </div>
          </div>

          {/*
           * A parse error is expected output, not an incident: it stays inline,
           * monospaced and pre-wrapped, so the column the parser points at still
           * lines up with the source above it.
           */}
          {validation ? (
            validation.ok ? (
              <p
                role="status"
                className="flex flex-none items-center gap-2 rounded border border-border bg-ok-weak px-2.5 py-1.5 text-sm text-text"
              >
                <Icon name="check" className="flex-none text-ok" />
                {t('script.valid')}
              </p>
            ) : (
              <div
                role="status"
                className="flex flex-none flex-col gap-1 rounded border border-danger bg-danger-weak px-2.5 py-2"
              >
                <p className="flex items-center gap-2 text-sm font-semibold text-text">
                  <Icon name="alert-circle" className="flex-none text-danger" />
                  {t('script.invalid')}
                </p>
                {validation.detail ? (
                  <pre className="max-h-24 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-2">
                    {validation.detail}
                  </pre>
                ) : null}
              </div>
            )
          ) : null}

          {/* ── Output ── */}
          <div className="flex h-40 flex-none flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-e1">
            <div className="flex h-7 flex-none items-center gap-2 border-b border-border bg-surface-2 px-2">
              <span className="text-2xs uppercase tracking-wider text-text-3">
                {t('script.output')}
              </span>
              {runId ? (
                <span className="flex items-center gap-1 text-sm text-text-2">
                  <Spinner /> {t('script.running')}
                </span>
              ) : null}
              {run ? (
                <span className="rounded-sm bg-ok-weak px-1.5 py-px font-mono text-2xs tnum text-ok">
                  {formatEta(run.durationMs / 1000)}
                </span>
              ) : null}
              <span className="flex-1" />
              <span className="truncate text-xs text-text-3">{t('script.logsNote')}</span>
            </div>
            <div className="min-h-0 flex-1 select-text overflow-auto bg-surface p-2 font-mono text-xs leading-relaxed">
              {runError ? (
                <ErrorState error={runError} title={t('script.runFailed')} compact />
              ) : run ? (
                <>
                  {run.logs.map((entry, index) => (
                    <p
                      key={`${entry.timestamp}-${index}`}
                      className={
                        entry.level === 'error'
                          ? 'whitespace-pre-wrap break-words rounded-sm bg-danger-weak px-1 text-danger'
                          : entry.level === 'warn'
                            ? 'whitespace-pre-wrap break-words rounded-sm bg-warn-weak px-1 text-warn'
                            : 'whitespace-pre-wrap break-words px-1 text-text-2'
                      }
                    >
                      {entry.message}
                    </p>
                  ))}
                  {run.result ? (
                    <p className="mt-1.5 select-text break-words border-t border-border px-1 pt-1.5 text-text">
                      {t('script.result')}: {run.result}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-text-3">{t('script.outputEmpty')}</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Host-function reference ── */}
        <aside className="hidden w-56 flex-none flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-e1 lg:flex">
          <h3 className="flex h-8 flex-none items-center border-b border-border bg-surface-2 px-2 text-2xs uppercase tracking-wider text-text-3">
            {t('script.reference')}
          </h3>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <ul className="flex flex-col">
              {SCRIPT_HOST_FUNCTIONS.map((fn) => (
                <li
                  key={fn}
                  className="select-text truncate rounded-sm px-1 py-0.5 font-mono text-xs text-text-2 transition-quick hover:bg-surface-2 hover:text-text"
                >
                  {fn}
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-xs text-text-3">{t('script.referenceHint')}</p>
            {sessionChoice === '' ? (
              <p className="mt-2 rounded border border-border bg-warn-weak px-2 py-1.5 text-xs text-text">
                {t('script.needsSession')}
              </p>
            ) : null}
          </div>
        </aside>
      </div>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={t('script.deleteTitle')}
        description={t('script.deleteBody', { name: deleting?.name ?? '' })}
        confirmLabel={t('delete.confirmOne', { name: deleting?.name ?? '' })}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      />
    </Dialog>
  );
}
