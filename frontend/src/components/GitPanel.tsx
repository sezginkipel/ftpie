/* eslint-disable react-refresh/only-export-components */
/**
 * GitPanel — deploy a git revision to the connected server.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <GitPanel className="min-h-0 flex-1" />
 * ```
 * The session comes from `sessionStore.active()`. The repository path, the
 * revision, the remote target and the exclude patterns are this panel's own
 * state; nothing is hidden in a constant the way the old hardcoded exclude list
 * was.
 *
 * ## The dry-run → plan → confirm → deploy flow
 * 1. **Preview** calls `deploy_branch` with `dryRun: true`. The backend builds
 *    the complete plan without contacting the server and returns a
 *    `DeployOutcome` whose `plan` *is* the answer.
 * 2. The plan is rendered in full: every upload with its source (commit vs
 *    working tree) and size, **every deletion**, and every skipped entry with
 *    its reason. Deletions now propagate to the server, so they get their own
 *    warning block rather than a footnote.
 * 3. **Deploy** is only enabled once a plan exists, and always goes through an
 *    `AlertDialog` whose confirm label names the counts. When the plan deletes
 *    anything, the dialog says how many files disappear and that the server
 *    cannot give them back.
 * 4. The real run passes a caller-generated `deployId` so `cancel_deploy` can
 *    target it, and live progress arrives on `deploy:progress`
 *    (`scanning | uploading | deleting | finished`) filtered to that id.
 *
 * `GitStatus.ahead`/`behind` are nullable and mean "no upstream". They are
 * rendered as such — never as `0/0`, which reads as "in sync".
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../lib/cn';
import { formatBytes, formatEta, truncateMiddle } from '../lib/format';
import { useT, type TFunction } from '../lib/i18n';
import { call } from '../lib/ipc';
import type {
  DeployArgs,
  DeployOutcome,
  DeployPlan,
  DeployProgress,
  GitFileStatus,
  GitStatus,
} from '../lib/types';
import { useSessionStore } from '../store/sessionStore';
import { DeployHistoryPanel } from './DeployHistoryPanel';
import {
  AlertDialog,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  Input,
  ProgressBar,
  Select,
  Separator,
  Tabs,
  Textarea,
  Tooltip,
  useToast,
} from './ui';

// ── Pure helpers (tested) ───────────────────────────────────────────────────

/** One exclude pattern per line, blanks and `#` comments dropped. */
export function parseExcludes(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * A cheap structural check for a globset pattern, so an obvious typo is caught
 * before a round trip. The backend is still the authority: an invalid pattern
 * comes back as a `config` error and is surfaced verbatim.
 */
export function isValidGlob(pattern: string): boolean {
  if (pattern.trim() === '') return false;
  let brackets = 0;
  let braces = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
    else if (ch === '{') braces += 1;
    else if (ch === '}') braces -= 1;
    if (brackets < 0 || braces < 0) return false;
  }
  return brackets === 0 && braces === 0;
}

/** The first pattern that fails {@link isValidGlob}, or `null`. */
export function firstInvalidGlob(patterns: string[]): string | null {
  return patterns.find((pattern) => !isValidGlob(pattern)) ?? null;
}

export interface PlanSummary {
  uploads: number;
  deletes: number;
  skipped: number;
  bytes: number;
  /** True when this deploy removes files from the server. */
  hasDeletions: boolean;
  /** True when there is nothing at all to do. */
  empty: boolean;
  /** Uploads whose bytes come from the dirty working tree, not from a commit. */
  worktreeUploads: number;
}

/** Everything the plan header states, derived in one place. */
export function summarisePlan(plan: DeployPlan): PlanSummary {
  const uploads = plan.uploads.length;
  const deletes = plan.deletes.length;
  return {
    uploads,
    deletes,
    skipped: plan.skipped.length,
    bytes: plan.totalBytes,
    hasDeletions: deletes > 0,
    empty: uploads === 0 && deletes === 0,
    worktreeUploads: plan.uploads.filter((upload) => upload.source === 'worktree').length,
  };
}

/** Honest ahead/behind text: `null` is "no upstream", not zero. */
export function upstreamLabel(status: GitStatus, t: TFunction): string {
  if (status.ahead === null || status.behind === null) return t('git.noUpstream');
  return t('git.aheadBehind', { ahead: status.ahead, behind: status.behind });
}

function fileStatusLabel(t: TFunction, status: GitFileStatus): string {
  switch (status) {
    case 'added':
      return t('git.status.added');
    case 'modified':
      return t('git.status.modified');
    case 'deleted':
      return t('git.status.deleted');
    case 'renamed':
      return t('git.status.renamed');
    case 'typechange':
      return t('git.status.typechange');
    case 'untracked':
      return t('git.status.untracked');
  }
}

const DEFAULT_EXCLUDES = ['node_modules/**', '.git/**', '*.map', '.env'].join('\n');
const LIST_LIMIT = 300;

// ── Component ───────────────────────────────────────────────────────────────

type GitTab = 'deploy' | 'history';

export interface GitPanelProps {
  className?: string;
}

export function GitPanel({ className }: GitPanelProps) {
  const { t } = useT();
  const { toast, showError } = useToast();

  const session = useSessionStore((s) => (s.activeId ? s.sessions[s.activeId] : null) ?? null);
  const activeUi = useSessionStore((s) => (s.activeId ? s.ui[s.activeId] : null) ?? null);

  const [tab, setTab] = useState<GitTab>('deploy');
  const [repoPath, setRepoPath] = useState<string | null>(null);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);

  const [rev, setRev] = useState('');
  const [remoteBase, setRemoteBase] = useState('');
  const [excludeText, setExcludeText] = useState(DEFAULT_EXCLUDES);
  const [includeUncommitted, setIncludeUncommitted] = useState(false);

  const [plan, setPlan] = useState<DeployPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [planError, setPlanError] = useState<unknown>(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState<DeployProgress | null>(null);
  const [outcome, setOutcome] = useState<DeployOutcome | null>(null);
  const deployIdRef = useRef<string | null>(null);

  const excludes = useMemo(() => parseExcludes(excludeText), [excludeText]);
  const badGlob = useMemo(() => firstInvalidGlob(excludes), [excludes]);
  const summary = useMemo(() => (plan ? summarisePlan(plan) : null), [plan]);

  // Seed the remote target from wherever the remote pane is sitting.
  useEffect(() => {
    if (remoteBase === '' && activeUi?.remotePath) setRemoteBase(activeUi.remotePath);
  }, [activeUi?.remotePath, remoteBase]);

  const loadRepo = useCallback(async (path: string) => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const [nextStatus, nextBranches, nextTags] = await Promise.all([
        call<GitStatus>('get_git_status', { repoPath: path }),
        call<string[]>('list_branches', { repoPath: path }),
        call<string[]>('list_tags', { repoPath: path }),
      ]);
      setStatus(nextStatus);
      setBranches(nextBranches);
      setTags(nextTags);
      setRev((current) => current || nextStatus.branch || 'HEAD');
    } catch (error) {
      setStatus(null);
      setBranches([]);
      setTags([]);
      setStatusError(error);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const pickRepo = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== 'string') return;
      setRepoPath(picked);
      setPlan(null);
      setOutcome(null);
      await loadRepo(picked);
    } catch (error) {
      showError(error, 'git.statusFailed');
    }
  }, [loadRepo, showError]);

  // Live deploy progress, filtered to the run we started. One listener for the
  // lifetime of the panel, torn down on unmount.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void listen<DeployProgress>('deploy:progress', (event) => {
      if (event.payload.deployId !== deployIdRef.current) return;
      setProgress(event.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // A window without the event bridge simply gets no live progress; the
        // final outcome still arrives from the command.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const buildArgs = useCallback(
    (dryRun: boolean, deployId: string | null): DeployArgs | null => {
      if (!session || !repoPath) return null;
      return {
        sessionId: session.id,
        repoPath,
        remoteBasePath: remoteBase.trim(),
        rev: rev.trim() || null,
        useHistoryBase: true,
        excludePatterns: excludes,
        includeUncommitted,
        dryRun,
        deployId,
      };
    },
    [excludes, includeUncommitted, remoteBase, repoPath, rev, session],
  );

  const preview = useCallback(async () => {
    const args = buildArgs(true, null);
    if (!args) return;
    if (args.remoteBasePath === '') {
      setPlanError({ code: 'config', message: t('deploy.remoteBaseRequired') });
      return;
    }

    setPreviewing(true);
    setPlanError(null);
    setOutcome(null);
    try {
      const result = await call<DeployOutcome>('deploy_branch', { args });
      setPlan(result.plan);
      const planned = summarisePlan(result.plan);
      toast({
        title: t('deploy.previewDone', {
          uploads: planned.uploads,
          deletes: planned.deletes,
        }),
        variant: 'info',
      });
    } catch (error) {
      setPlan(null);
      setPlanError(error);
    } finally {
      setPreviewing(false);
    }
  }, [buildArgs, t, toast]);

  const deploy = useCallback(async () => {
    const deployId = crypto.randomUUID();
    const args = buildArgs(false, deployId);
    if (!args) return;

    deployIdRef.current = deployId;
    setDeploying(true);
    setProgress(null);
    setPlanError(null);
    try {
      const result = await call<DeployOutcome>('deploy_branch', { args });
      setOutcome(result);
      setPlan(result.plan);
      if (result.cancelled) {
        toast({ title: t('deploy.cancelledNotice'), variant: 'warn' });
      } else if (result.failed > 0) {
        toast({ title: t('deploy.partial', { failed: result.failed }), variant: 'warn' });
      } else {
        toast({
          title: t('deploy.succeeded', {
            uploads: result.uploaded,
            duration: formatEta(result.durationMs / 1000),
          }),
          variant: 'ok',
        });
      }
    } catch (error) {
      setPlanError(error);
      showError(error, 'deploy.failed');
    } finally {
      setDeploying(false);
      deployIdRef.current = null;
      setProgress(null);
    }
  }, [buildArgs, showError, t, toast]);

  const cancelDeploy = useCallback(async () => {
    const id = deployIdRef.current;
    if (!id) return;
    try {
      await call<void>('cancel_deploy', { deployId: id });
    } catch (error) {
      showError(error);
    }
  }, [showError]);

  const revisionOptions = useMemo(() => {
    const options = [{ value: 'HEAD', label: 'HEAD' }];
    for (const branch of branches) options.push({ value: branch, label: branch });
    for (const name of tags) options.push({ value: name, label: `${name} (${t('git.tag')})` });
    if (rev && !options.some((option) => option.value === rev)) {
      options.unshift({ value: rev, label: rev });
    }
    return options;
  }, [branches, rev, tags, t]);

  return (
    <section
      className={cn('flex min-h-0 flex-col bg-surface', className)}
      aria-label={t('git.title')}
    >
      <Tabs
        label={t('git.title')}
        value={tab}
        onValueChange={setTab}
        tabs={[
          { id: 'deploy', label: t('git.tabDeploy') },
          { id: 'history', label: t('git.tabHistory') },
        ]}
        className="min-h-0 flex-1"
      >
        {tab === 'history' ? (
          <DeployHistoryPanel
            sessionId={session?.id ?? null}
            repoPath={repoPath}
            excludePatterns={excludes}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
            {/* ── Repository ── */}
            <div className="-mx-2 -mt-2 mb-0.5 flex h-toolbar flex-none items-center gap-2 border-b border-border bg-surface-2 px-2">
              <Button
                size="sm"
                className="press"
                icon={<Icon name="folder-open" />}
                onClick={() => void pickRepo()}
              >
                {t('git.pickRepo')}
              </Button>
              {repoPath ? (
                <>
                  <Tooltip content={repoPath} mono>
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-text-2">
                      {truncateMiddle(repoPath, 64)}
                    </span>
                  </Tooltip>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="press"
                    icon={<Icon name="refresh" />}
                    loading={loadingStatus}
                    onClick={() => void loadRepo(repoPath)}
                  >
                    {t('git.reload')}
                  </Button>
                </>
              ) : (
                <span className="text-sm text-text-3">{t('git.noRepoHint')}</span>
              )}
            </div>

            {!repoPath ? (
              <EmptyState
                icon="git-branch"
                title={t('git.noRepo')}
                description={t('git.noRepoHint')}
                compact
              />
            ) : statusError ? (
              <ErrorState
                error={statusError}
                title={t('git.statusFailed')}
                compact
                onRetry={() => void loadRepo(repoPath)}
              />
            ) : status ? (
              <>
                {/*
                 * Status strip. `ahead`/`behind` are nullable and mean "no
                 * upstream" — rendered as such, never as 0/0, which would read
                 * as "in sync".
                 */}
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-sm shadow-e1">
                  <Icon name="git-branch" className="flex-none text-accent" />
                  <span className="font-mono font-medium text-text">
                    {status.detached ? t('git.detached') : (status.branch ?? '—')}
                  </span>
                  <span
                    className={cn(
                      'flex-none rounded-sm px-1.5 py-px text-2xs tnum uppercase tracking-wider',
                      status.upstream ? 'bg-surface-3 text-text-2' : 'bg-warn-weak text-warn',
                    )}
                  >
                    {upstreamLabel(status, t)}
                  </span>
                  <span
                    className={cn(
                      'flex-none rounded-sm px-1.5 py-px text-2xs tnum uppercase tracking-wider',
                      status.isDirty ? 'bg-warn-weak text-warn' : 'bg-ok-weak text-ok',
                    )}
                  >
                    {status.isDirty
                      ? t('git.dirty', { count: status.changedFiles.length })
                      : t('git.clean')}
                  </span>
                  {status.lastCommit ? (
                    <Tooltip content={status.lastCommit.message}>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-3">
                        {status.lastCommit.shortHash} {status.lastCommit.message}
                      </span>
                    </Tooltip>
                  ) : null}
                </div>

                {status.changedFiles.length > 0 ? (
                  <details className="group overflow-hidden rounded border border-border bg-surface">
                    <summary className="flex cursor-default select-none items-center gap-2 bg-surface-2 px-2 py-1.5 text-sm text-text-2 transition-quick hover:bg-surface-3">
                      <Icon
                        name="chevron-right"
                        className="flex-none text-text-3 transition-base group-open:rotate-90"
                      />
                      <span className="font-medium">{t('git.changedFiles')}</span>
                      <span className="rounded-sm bg-surface-3 px-1.5 text-2xs tnum text-text-2">
                        {status.changedFiles.length}
                      </span>
                    </summary>
                    <ul className="max-h-32 overflow-auto border-t border-border">
                      {status.changedFiles.slice(0, LIST_LIMIT).map((file) => (
                        <li
                          key={`${file.status}:${file.path}`}
                          className="flex h-6 items-center gap-2 px-2 text-xs transition-quick hover:bg-surface-2"
                        >
                          <span className="w-[76px] flex-none truncate text-2xs uppercase tracking-wider text-text-3">
                            {fileStatusLabel(t, file.status)}
                          </span>
                          <span className="truncate font-mono text-text-2">{file.path}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}

                <Separator />

                {/* ── Deploy form ── */}
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={t('git.revision')} hint={t('git.revisionHint')}>
                    {({ id, describedBy }) => (
                      <Select
                        id={id}
                        aria-describedby={describedBy}
                        value={rev || 'HEAD'}
                        onValueChange={setRev}
                        options={revisionOptions}
                      />
                    )}
                  </Field>

                  <Field
                    label={t('deploy.remoteBase')}
                    error={remoteBase.trim() === '' ? t('deploy.remoteBaseRequired') : null}
                  >
                    {({ id, describedBy, invalid }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        invalid={invalid}
                        mono
                        value={remoteBase}
                        onChange={(event) => setRemoteBase(event.target.value)}
                        placeholder="/var/www/html"
                      />
                    )}
                  </Field>
                </div>

                <Field
                  label={t('deploy.excludes')}
                  hint={t('deploy.excludesHint')}
                  error={badGlob ? t('deploy.excludeInvalid', { pattern: badGlob }) : null}
                >
                  {({ id, describedBy, invalid }) => (
                    <Textarea
                      id={id}
                      aria-describedby={describedBy}
                      invalid={invalid}
                      mono
                      rows={4}
                      value={excludeText}
                      onChange={(event) => setExcludeText(event.target.value)}
                    />
                  )}
                </Field>

                <Checkbox
                  checked={includeUncommitted}
                  onCheckedChange={setIncludeUncommitted}
                  label={t('deploy.includeUncommitted')}
                  hint={t('deploy.includeUncommittedHint')}
                />

                <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface-2 px-2 py-2">
                  <Button
                    size="sm"
                    className="press"
                    icon={<Icon name="list" />}
                    loading={previewing}
                    disabled={badGlob !== null || remoteBase.trim() === '' || !session}
                    onClick={() => void preview()}
                  >
                    {t('deploy.dryRun')}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    className="press"
                    icon={<Icon name="upload" />}
                    disabled={!plan || summary?.empty || deploying || badGlob !== null || !session}
                    onClick={() => setConfirmOpen(true)}
                  >
                    {t('deploy.deployNow')}
                  </Button>
                  {deploying ? (
                    <Button
                      size="sm"
                      variant="danger"
                      className="press"
                      icon={<Icon name="stop" />}
                      onClick={() => void cancelDeploy()}
                    >
                      {t('deploy.cancel')}
                    </Button>
                  ) : null}
                  <span className="min-w-0 flex-1 text-xs text-text-3">
                    {t('deploy.dryRunHint')}
                  </span>
                </div>

                {!session ? (
                  <p
                    role="note"
                    className="flex items-center gap-2 rounded border border-border bg-warn-weak px-2.5 py-1.5 text-sm text-text"
                  >
                    <Icon name="alert-triangle" className="flex-none text-warn" />
                    {t('error.noSession')}
                  </p>
                ) : null}

                {/* ── Live progress ── */}
                {deploying ? (
                  <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-2.5 shadow-e1">
                    <ProgressBar
                      value={
                        progress && progress.total > 0
                          ? Math.min(1, progress.current / progress.total)
                          : null
                      }
                      label={t('deploy.running')}
                      tone="info"
                      height={6}
                    />
                    <p className="text-sm tnum text-text-2">
                      {progress
                        ? progress.phase === 'scanning'
                          ? t('deploy.phase.scanning')
                          : progress.phase === 'deleting'
                            ? t('deploy.phase.deleting', {
                                current: progress.current,
                                total: progress.total,
                              })
                            : progress.phase === 'finished'
                              ? t('deploy.phase.finished')
                              : t('deploy.phase.uploading', {
                                  current: progress.current,
                                  total: progress.total,
                                })
                        : t('deploy.running')}
                    </p>
                    {progress ? (
                      <p className="truncate font-mono text-xs text-text-3">
                        {progress.path || progress.remotePath}
                        {progress.bytes > 0
                          ? ` · ${t('deploy.progressBytes', {
                              size: formatBytes(progress.bytes),
                            })}`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {planError ? <ErrorState error={planError} compact /> : null}

                {/* ── The plan ── */}
                {plan && summary ? (
                  <PlanView plan={plan} summary={summary} outcome={outcome} />
                ) : (
                  <EmptyState
                    icon="list"
                    title={t('deploy.noPlanYet')}
                    description={t('deploy.noPlanYetHint')}
                    compact
                  />
                )}
              </>
            ) : null}
          </div>
        )}
      </Tabs>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        tone={summary?.hasDeletions ? 'danger' : 'primary'}
        title={t('deploy.confirmTitle', { host: session?.host ?? '' })}
        description={t('deploy.confirmBody', {
          uploads: summary?.uploads ?? 0,
          path: plan?.remoteBasePath ?? '',
          host: session?.host ?? '',
          commit: plan?.commitSha.slice(0, 8) ?? '',
        })}
        confirmLabel={
          summary?.hasDeletions
            ? t('deploy.confirmWithDeletes', {
                uploads: summary.uploads,
                deletes: summary.deletes,
              })
            : t('deploy.confirm', { count: summary?.uploads ?? 0 })
        }
        loading={deploying}
        onConfirm={() => {
          setConfirmOpen(false);
          void deploy();
        }}
      >
        {summary?.hasDeletions ? (
          <div className="flex items-start gap-2.5 rounded border border-[var(--danger)] bg-danger-weak p-2.5">
            <Icon name="trash" size={16} className="mt-px flex-none text-danger" />
            <div className="min-w-0">
              <p className="text-base font-semibold tracking-tight text-text">
                {t('deploy.deletionsWarningTitle')}
              </p>
              <p className="mt-0.5 text-sm text-text-2">
                {t('deploy.deletionsWarningBody', { count: summary.deletes })}
              </p>
            </div>
          </div>
        ) : null}
        {plan?.includeUncommitted ? (
          <p className="mt-2 flex items-center gap-2 rounded border border-border bg-warn-weak px-2.5 py-1.5 text-sm text-text">
            <Icon name="alert-triangle" className="flex-none text-warn" />
            {t('deploy.source.worktree')}
          </p>
        ) : null}
      </AlertDialog>
    </section>
  );
}

// ── Plan rendering ──────────────────────────────────────────────────────────

/**
 * One number from the plan, sized so it can be read at a glance.
 *
 * Deletions are the entry that matters: they now propagate to the server, so the
 * count is tinted `danger` while uploads are `ok`, and neither is conveyed by
 * the colour alone — each tile is labelled.
 */
function PlanStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'danger' | 'neutral';
}) {
  return (
    <div
      className={cn(
        'flex min-w-[92px] flex-col gap-0.5 rounded border px-2.5 py-1.5',
        tone === 'ok' && 'border-ok bg-ok-weak',
        tone === 'danger' && 'border-danger bg-danger-weak',
        tone === 'neutral' && 'border-border bg-surface-2',
      )}
    >
      <span className="text-2xs uppercase tracking-wider text-text-3">{label}</span>
      <span
        className={cn(
          'text-lg font-semibold tnum tracking-tight',
          tone === 'ok' && 'text-ok',
          tone === 'danger' && 'text-danger',
          tone === 'neutral' && 'text-text',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function PlanView({
  plan,
  summary,
  outcome,
}: {
  plan: DeployPlan;
  summary: PlanSummary;
  outcome: DeployOutcome | null;
}) {
  const { t } = useT();

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-2.5 shadow-e1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold tracking-tight text-text">{t('deploy.planTitle')}</h3>
        <span className="select-all rounded-sm bg-accent-weak px-1.5 py-px font-mono text-xs tnum text-accent">
          {plan.commitSha.slice(0, 8)}
        </span>
        <span className="flex-1" />
        {outcome && !outcome.dryRun ? (
          <span
            className={cn(
              'rounded-sm px-1.5 py-px text-2xs uppercase tracking-wider',
              outcome.success ? 'bg-ok-weak text-ok' : 'bg-danger-weak text-danger',
            )}
          >
            {outcome.success ? t('history.outcomeSuccess') : t('history.outcomeFailure')}
          </span>
        ) : null}
      </div>

      {/* The counts, as the first thing the eye lands on. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('deploy.planSummaryLabel')}>
        <PlanStat
          label={t('deploy.uploadsHeading')}
          value={String(summary.uploads)}
          tone={summary.uploads > 0 ? 'ok' : 'neutral'}
        />
        <PlanStat
          label={t('deploy.deletesHeading')}
          value={String(summary.deletes)}
          tone={summary.hasDeletions ? 'danger' : 'neutral'}
        />
        <PlanStat
          label={t('deploy.skippedHeading')}
          value={String(summary.skipped)}
          tone="neutral"
        />
        <PlanStat
          label={t('deploy.planBytesLabel')}
          value={formatBytes(summary.bytes)}
          tone="neutral"
        />
      </div>

      {summary.empty ? (
        <p className="rounded border border-border bg-surface-2 px-2.5 py-2 text-sm text-text-2">
          {t('deploy.planEmpty')}
        </p>
      ) : null}

      {summary.worktreeUploads > 0 ? (
        <p
          role="note"
          className="flex items-center gap-2 rounded border border-border bg-warn-weak px-2.5 py-1.5 text-sm text-text"
        >
          <Icon name="alert-triangle" className="flex-none text-warn" />
          <span className="tnum">
            {t('deploy.source.worktree')} ({summary.worktreeUploads})
          </span>
        </p>
      ) : null}

      {summary.hasDeletions ? (
        <div className="flex items-start gap-2.5 rounded border border-[var(--danger)] bg-danger-weak p-2.5">
          <Icon name="trash" size={16} className="mt-px flex-none text-danger" />
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-tight text-text">
              {t('deploy.deletionsWarningTitle')}
            </p>
            <p className="mt-0.5 text-sm text-text-2">
              {t('deploy.deletionsWarningBody', { count: summary.deletes })}
            </p>
          </div>
        </div>
      ) : null}

      <PlanList
        heading={t('deploy.deletesHeading')}
        count={plan.deletes.length}
        tone="danger"
        rows={plan.deletes.slice(0, LIST_LIMIT).map((entry) => ({
          key: entry.remotePath,
          left: entry.path,
          right: entry.remotePath,
        }))}
      />
      <PlanList
        heading={t('deploy.uploadsHeading')}
        count={plan.uploads.length}
        tone="ok"
        rows={plan.uploads.slice(0, LIST_LIMIT).map((entry) => ({
          key: entry.remotePath,
          left: entry.path,
          right: `${formatBytes(entry.size)} · ${
            entry.source === 'tree' ? t('deploy.source.tree') : t('deploy.source.worktree')
          }`,
        }))}
      />
      <PlanList
        heading={t('deploy.skippedHeading')}
        count={plan.skipped.length}
        tone="neutral"
        rows={plan.skipped.slice(0, LIST_LIMIT).map((entry) => ({
          key: `${entry.reason}:${entry.path}`,
          left: entry.path,
          right:
            entry.reason === 'excluded'
              ? t('deploy.skipReason.excluded')
              : entry.reason === 'symlink'
                ? t('deploy.skipReason.symlink')
                : t('deploy.skipReason.submodule'),
        }))}
      />
    </div>
  );
}

function PlanList({
  heading,
  count,
  tone,
  rows,
}: {
  heading: string;
  count: number;
  tone: 'ok' | 'danger' | 'neutral';
  rows: { key: string; left: string; right: string }[];
}) {
  const { t } = useT();
  if (count === 0) return null;

  return (
    <details className="group overflow-hidden rounded border border-border bg-surface">
      {/*
       * The summary bar carries the tone, so an expanded deletions list is
       * unmistakably a deletions list even after scrolling into it.
       */}
      <summary
        className={cn(
          'flex cursor-default select-none items-center gap-2 px-2 py-1.5 text-sm transition-quick',
          tone === 'danger' &&
            'bg-danger-weak text-text hover:shadow-[inset_3px_0_0_0_var(--danger)]',
          tone === 'ok' && 'bg-ok-weak text-text hover:shadow-[inset_3px_0_0_0_var(--ok)]',
          tone === 'neutral' && 'bg-surface-2 text-text-2 hover:bg-surface-3',
        )}
      >
        <Icon
          name="chevron-right"
          className="flex-none text-text-3 transition-base group-open:rotate-90"
        />
        <Icon
          name={tone === 'danger' ? 'trash' : tone === 'ok' ? 'upload' : 'minus'}
          className={cn(
            'flex-none',
            tone === 'danger' && 'text-danger',
            tone === 'ok' && 'text-ok',
            tone === 'neutral' && 'text-text-3',
          )}
        />
        <span className="font-medium">{heading}</span>
        <span
          className={cn(
            'rounded-sm px-1.5 text-2xs tnum',
            tone === 'danger' && 'bg-danger-weak text-danger',
            tone === 'ok' && 'bg-ok-weak text-ok',
            tone === 'neutral' && 'bg-surface-3 text-text-2',
          )}
        >
          {count}
        </span>
      </summary>
      <ul className="max-h-40 overflow-auto border-t border-border">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex h-6 items-center gap-2 px-2 text-xs transition-quick hover:bg-surface-2"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-text">{row.left}</span>
            <span className="flex-none truncate font-mono tnum text-text-3">{row.right}</span>
          </li>
        ))}
      </ul>
      {count > rows.length ? (
        <p className="border-t border-border bg-surface-2 px-2 py-1 text-xs tnum text-text-3">
          {t('deploy.listTruncated', { count: count - rows.length })}
        </p>
      ) : null}
    </details>
  );
}
