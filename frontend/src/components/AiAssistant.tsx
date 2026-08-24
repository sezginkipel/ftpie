/* eslint-disable react-refresh/only-export-components */
/**
 * AiAssistant — ask about the current folder, review proposed actions, confirm
 * each one individually.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <AiAssistant className="min-h-0 flex-1" />
 * ```
 * Context comes from `sessionStore`: the active session's remote path, local
 * path and remote selection. The old panel was mounted with
 * `currentRemotePath={undefined}` and `selectedFiles={[]}`, so the assistant was
 * always answering with no context at all.
 *
 * ## Security posture
 * - **No key ever touches this component.** `ai_query` takes no API key; keys
 *   live in the backend vault and are managed in Settings → AI. This panel only
 *   ever learns *whether* a provider has one, from `ai_list_providers`.
 * - **Model output is untrusted text.** It is rendered into a `<p>` with
 *   `whiteSpace: pre-wrap`. No HTML, no markdown renderer, no
 *   `dangerouslySetInnerHTML`.
 * - **Actions are inert until confirmed.** Each proposal is listed with the
 *   *backend-generated* `description` — never a model-supplied label — and needs
 *   its own click. Destructive ones are marked.
 * - There are exactly five action types, all remote-only. There is deliberately
 *   no script-execution and no file-upload action backend-side, and nothing here
 *   implies otherwise: see {@link SUPPORTED_ACTION_TYPES}.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '../lib/cn';
import { useT, type TFunction } from '../lib/i18n';
import { call } from '../lib/ipc';
import type {
  AiAction,
  AiActionProposal,
  AiProvider,
  AiProviderInfo,
  AiQueryArgs,
  AiResponse,
} from '../lib/types';
import { useSessionStore } from '../store/sessionStore';
import { validateBaseUrl } from './SettingsDialog';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  Select,
  Spinner,
  Textarea,
  useToast,
} from './ui';

// ── Action rendering (pure, tested) ─────────────────────────────────────────

/**
 * The complete set of actions the backend will ever propose. All five operate
 * on remote paths of a server the user is already authenticated to.
 *
 * **There is no script-execution action and no file-upload action**, by design:
 * a model-chosen local path could not be confined to a trustworthy root, and
 * uploads go through the user-driven transfer queue where a human picks the
 * file. Nothing may be added here without a backend variant to match.
 */
export const SUPPORTED_ACTION_TYPES = [
  'rename_file',
  'move_file',
  'delete_file',
  'create_directory',
  'change_permissions',
] as const;

/** Short, translated label for the action's kind — a badge, not the description. */
export function actionKindLabel(action: AiAction, t: TFunction): string {
  switch (action.type) {
    case 'rename_file':
      return t('ai.action.rename_file');
    case 'move_file':
      return t('ai.action.move_file');
    case 'delete_file':
      return t('ai.action.delete_file');
    case 'create_directory':
      return t('ai.action.create_directory');
    case 'change_permissions':
      return t('ai.action.change_permissions');
  }
}

/** The remote paths an action touches, for a monospace detail line. */
export function actionPaths(action: AiAction): string[] {
  switch (action.type) {
    case 'rename_file':
    case 'move_file':
      return [action.from, action.to];
    case 'delete_file':
    case 'create_directory':
      return [action.path];
    case 'change_permissions':
      return [action.path, action.mode];
  }
}

// ── Conversation model ──────────────────────────────────────────────────────

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  /** Untrusted for an assistant turn — rendered as plain text either way. */
  text: string;
  actions: AiActionProposal[];
  rejectedActions: number;
}

let nextTurnId = 1;

export interface AiAssistantProps {
  className?: string;
}

export function AiAssistant({ className }: AiAssistantProps) {
  const { t } = useT();
  const { toast, showError } = useToast();

  const session = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null) ?? null);
  const ui = useSessionStore((s) => (s.activeId ? s.ui[s.activeId] : null) ?? null);

  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null);
  const [providersError, setProvidersError] = useState<unknown>(null);
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setProvidersError(null);
    try {
      setProviders(await call<AiProviderInfo[]>('ai_list_providers'));
    } catch (error) {
      setProviders(null);
      setProvidersError(error);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const info = useMemo(
    () => providers?.find((entry) => entry.provider === provider) ?? null,
    [provider, providers],
  );

  const needsKey = info ? info.requiresKey && !info.hasKey : false;
  // The backend rejects anything that is not https (or http on loopback); say so
  // in the field rather than after a round trip.
  const baseUrlVerdict = info?.needsBaseUrl ? validateBaseUrl(baseUrl) : 'ok';
  const baseUrlError =
    baseUrlVerdict === 'empty'
      ? t('ai.baseUrlRequired')
      : baseUrlVerdict === 'invalid'
        ? t('ai.baseUrlInvalid')
        : null;

  const ask = useCallback(async () => {
    const text = prompt.trim();
    if (text === '' || asking) return;

    const userTurn: Turn = {
      id: nextTurnId++,
      role: 'user',
      text,
      actions: [],
      rejectedActions: 0,
    };
    setTurns((current) => [...current, userTurn]);
    setPrompt('');
    setAsking(true);

    try {
      const args: AiQueryArgs = {
        prompt: text,
        provider,
        model: model.trim() === '' ? null : model.trim(),
        baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
        context: {
          remotePath: ui?.remotePath ?? null,
          localPath: ui?.localPath ?? null,
          selectedFiles: ui?.selection.remote ?? [],
          gitBranch: null,
          fileListing: null,
        },
      };
      const response = await call<AiResponse>('ai_query', { args });
      setTurns((current) => [
        ...current,
        {
          id: nextTurnId++,
          role: 'assistant',
          text: response.message,
          actions: response.actions,
          rejectedActions: response.rejectedActions,
        },
      ]);
    } catch (error) {
      showError(error, 'ai.queryFailed');
    } finally {
      setAsking(false);
    }
  }, [asking, baseUrl, model, prompt, provider, showError, ui]);

  const apply = useCallback(
    async (key: string, proposal: AiActionProposal) => {
      if (!session) return;
      setApplying(key);
      try {
        const message = await call<string>('ai_apply_action', {
          action: proposal.action,
          sessionId: session.id,
        });
        setApplied((current) => ({ ...current, [key]: message }));
        toast({
          title: t('ai.actionApplied', { description: proposal.description }),
          variant: 'ok',
        });
      } catch (error) {
        showError(error, 'ai.actionFailed');
      } finally {
        setApplying(null);
      }
    },
    [session, showError, t, toast],
  );

  const providerOptions = useMemo(
    () =>
      (providers ?? []).map((entry) => ({
        value: entry.provider,
        label:
          entry.provider === 'anthropic'
            ? t('ai.provider.anthropic')
            : entry.provider === 'openai'
              ? t('ai.provider.openai')
              : entry.provider === 'ollama'
                ? t('ai.provider.ollama')
                : t('ai.provider.custom'),
      })),
    [providers, t],
  );

  return (
    <section
      className={cn('flex min-h-0 flex-col bg-surface', className)}
      aria-label={t('ai.title')}
    >
      {/* ── Provider row: chrome, one surface step above the conversation ── */}
      <div className="flex flex-none flex-col gap-2 border-b border-border bg-surface-2 p-2">
        {providersError ? (
          <ErrorState
            error={providersError}
            title={t('ai.providersFailed')}
            compact
            onRetry={() => void loadProviders()}
          />
        ) : providers === null ? (
          <p className="flex items-center gap-1.5 text-sm text-text-3">
            <Spinner /> {t('common.loading')}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t('ai.provider')} className="w-40">
                {({ id }) => (
                  <Select
                    id={id}
                    value={provider}
                    onValueChange={(value) => setProvider(value as AiProvider)}
                    options={providerOptions}
                  />
                )}
              </Field>
              <Field label={t('ai.model')} className="min-w-[160px] flex-1">
                {({ id }) => (
                  <Input
                    id={id}
                    mono
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder={info?.defaultModel ?? ''}
                  />
                )}
              </Field>
              <span
                className={cn(
                  'mb-1 flex-none rounded-sm px-1.5 py-1 text-2xs uppercase tracking-wider',
                  info?.hasKey
                    ? 'bg-ok-weak text-ok'
                    : info?.requiresKey
                      ? 'bg-danger-weak text-danger'
                      : 'bg-surface-3 text-text-2',
                )}
              >
                {info?.hasKey
                  ? t('ai.keyConfigured')
                  : info?.requiresKey
                    ? t('ai.keyNotConfigured')
                    : t('settings.aiProviderNoKey')}
              </span>
            </div>

            {info?.needsBaseUrl ? (
              <Field label={t('ai.baseUrl')} hint={t('ai.baseUrlInvalid')} error={baseUrlError}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    mono
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://…"
                  />
                )}
              </Field>
            ) : null}

            {needsKey ? (
              <p
                role="note"
                className="flex items-start gap-2 rounded border border-warn bg-warn-weak px-2.5 py-1.5 text-sm text-text"
              >
                <Icon name="key" className="mt-px flex-none text-warn" />
                <span>
                  {t('ai.keyMissing', { provider })} {t('ai.manageKeys')}
                </span>
              </p>
            ) : null}
          </>
        )}

        {/* ── Context actually sent ── */}
        <p className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-2 py-1 text-xs text-text-3">
          <Icon name="info" className="flex-none" />
          <span className="font-semibold uppercase tracking-wider">{t('ai.context')}</span>
          {ui?.remotePath ? (
            <span className="font-mono">{t('ai.contextPath', { path: ui.remotePath })}</span>
          ) : null}
          {ui && ui.selection.remote.length > 0 ? (
            <span className="tnum">
              {t('ai.contextSelection', { count: ui.selection.remote.length })}
            </span>
          ) : null}
          {!ui ? <span>{t('ai.contextNone')}</span> : null}
        </p>
      </div>

      {/* ── Conversation ── */}
      <div
        className="min-h-0 flex-1 overflow-auto bg-bg p-3"
        role="log"
        aria-label={t('ai.conversation')}
      >
        {turns.length === 0 ? (
          <EmptyState
            icon="sparkles"
            title={t('ai.greeting')}
            description={t('ai.actionsRemoteOnly')}
            compact
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {turns.map((turn) => (
              <li key={turn.id} className="flex flex-col gap-1.5">
                {/*
                 * A turn reads as a turn: a speaker chip, then the text in a
                 * bubble the speaker owns. The user's is the accent side; the
                 * assistant's is a plain panel, because its content is not
                 * trusted and should not look authoritative.
                 */}
                <span className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-text-3">
                  <span
                    className={cn(
                      'flex h-4 w-4 flex-none items-center justify-center rounded-sm',
                      turn.role === 'user'
                        ? 'bg-accent-weak text-accent'
                        : 'bg-surface-2 text-text-2',
                    )}
                  >
                    <Icon name={turn.role === 'user' ? 'edit' : 'sparkles'} />
                  </span>
                  {turn.role === 'user' ? t('ai.you') : t('ai.assistantLabel')}
                </span>
                {/* Untrusted text: plain, pre-wrapped, never HTML. */}
                <p
                  className={cn(
                    'select-text whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-base leading-relaxed',
                    turn.role === 'user'
                      ? 'border-accent-line bg-accent-weak text-text'
                      : 'border-border bg-surface text-text shadow-e1',
                  )}
                >
                  {turn.text}
                </p>

                {turn.role === 'assistant' ? (
                  <>
                    {turn.rejectedActions > 0 ? (
                      <p
                        role="note"
                        className="flex items-start gap-2 rounded border border-border bg-warn-weak px-2.5 py-1.5 text-sm text-text"
                      >
                        <Icon name="alert-triangle" className="mt-px flex-none text-warn" />
                        <span className="tnum">
                          {t('ai.rejectedActions', { count: turn.rejectedActions })}
                        </span>
                      </p>
                    ) : null}

                    {turn.actions.length === 0 ? (
                      <p className="text-sm text-text-3">{t('ai.noActions')}</p>
                    ) : (
                      <div
                        className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-2 shadow-e1"
                        role="group"
                        aria-label={t('ai.proposals')}
                      >
                        <div className="flex flex-wrap items-baseline gap-2">
                          <p className="text-2xs font-semibold uppercase tracking-wider text-text-3">
                            {t('ai.actionsTitle')}
                          </p>
                          <span className="rounded-sm bg-surface-2 px-1.5 text-2xs tnum text-text-2">
                            {turn.actions.length}
                          </span>
                          <p className="min-w-0 flex-1 text-xs text-text-3">
                            {t('ai.actionsNote')}
                          </p>
                        </div>
                        <ul className="flex flex-col gap-1.5">
                          {turn.actions.map((proposal, index) => {
                            const key = `${turn.id}:${index}`;
                            const done = applied[key];
                            return (
                              <li
                                key={key}
                                // Each proposal is its own card with its own
                                // button. Nothing is ever applied in bulk, and a
                                // destructive one is tinted so it cannot be
                                // clicked through by muscle memory.
                                className={cn(
                                  'flex items-start gap-2.5 rounded border p-2 transition-quick',
                                  proposal.destructive
                                    ? 'border-danger bg-danger-weak'
                                    : 'border-border bg-surface-2',
                                  done && 'opacity-80',
                                )}
                              >
                                <span
                                  className={cn(
                                    'mt-px flex-none rounded-sm px-1.5 py-px text-2xs uppercase tracking-wider',
                                    proposal.destructive
                                      ? 'bg-danger-weak text-danger'
                                      : 'bg-surface-3 text-text-2',
                                  )}
                                >
                                  {actionKindLabel(proposal.action, t)}
                                </span>
                                <div className="min-w-0 flex-1">
                                  {/* Backend-generated description, not the model's. */}
                                  <p className="select-text break-words text-base text-text">
                                    {proposal.description}
                                  </p>
                                  <p className="mt-0.5 select-text break-all font-mono text-xs text-text-3">
                                    {actionPaths(proposal.action).join(' → ')}
                                  </p>
                                  {proposal.destructive ? (
                                    <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-danger">
                                      <Icon name="alert-triangle" className="flex-none" />
                                      {t('ai.actionDestructive')}
                                    </p>
                                  ) : null}
                                  {done ? (
                                    <p className="mt-1 flex items-start gap-1.5 rounded-sm bg-ok-weak px-1.5 py-1 text-xs text-ok">
                                      <Icon name="check" className="mt-px flex-none" />
                                      <span className="select-text break-words">{done}</span>
                                    </p>
                                  ) : null}
                                </div>
                                <Button
                                  size="sm"
                                  className="press"
                                  variant={proposal.destructive ? 'danger' : 'secondary'}
                                  icon={<Icon name={done ? 'check' : 'play'} />}
                                  loading={applying === key}
                                  disabled={Boolean(done) || !session}
                                  onClick={() => void apply(key, proposal)}
                                >
                                  {done ? t('common.done') : t('ai.actionApply')}
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                        {!session ? (
                          <p
                            role="note"
                            className="rounded border border-border bg-warn-weak px-2.5 py-1.5 text-sm text-text"
                          >
                            {t('ai.needsSessionForActions')}
                          </p>
                        ) : null}
                        <p className="text-xs text-text-3">{t('ai.actionsRemoteOnly')}</p>
                      </div>
                    )}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Composer ── */}
      <div className="flex flex-none flex-col gap-1.5 border-t border-border bg-surface-2 p-2">
        <Textarea
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void ask();
            }
          }}
          placeholder={t('ai.placeholder')}
          aria-label={t('ai.placeholder')}
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-xs text-text-3">{t('ai.untrustedNote')}</span>
          <Button
            size="sm"
            variant="ghost"
            className="press"
            onClick={() => {
              setTurns([]);
              setApplied({});
            }}
            disabled={turns.length === 0}
          >
            {t('ai.clear')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="press"
            icon={<Icon name="sparkles" />}
            loading={asking}
            disabled={prompt.trim() === '' || needsKey || baseUrlError !== null}
            onClick={() => void ask()}
          >
            {asking ? t('ai.thinking') : t('ai.send')}
          </Button>
        </div>
      </div>
    </section>
  );
}
