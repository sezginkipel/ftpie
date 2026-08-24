/**
 * DeployHistoryPanel — what was deployed, and the honest rollback path.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <DeployHistoryPanel
 *   sessionId={session?.id ?? null}
 *   repoPath={repoPath}
 *   excludePatterns={excludes}
 * />
 * ```
 * `GitPanel` already renders it under its History tab; mount it standalone only
 * if the shell wants history somewhere else too.
 *
 * ## Rollback is "go back to", not "undo"
 * The confirm dialog says so in those words, and then lists what it cannot do,
 * straight from the backend's own doc comment: it will not remove files added by
 * later deploys unless the full-tree option is used, it cannot restore content
 * that was never committed, it fails if the commit has left the local
 * repository, and it does not restore modes, timestamps or ownership. Nothing
 * here promises a transaction, because a deploy is not one.
 */
import { useCallback, useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import { formatBytes, formatDate, formatEta } from '../lib/format';
import { useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import type { DeployOutcome, DeployRecord, RollbackArgs } from '../lib/types';
import { useSettingsStore } from '../store/settingsStore';
import {
  AlertDialog,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Icon,
  Spinner,
  Tooltip,
  useToast,
} from './ui';

const HISTORY_LIMIT = 100;

export interface DeployHistoryPanelProps {
  /** Session the rollback uploads through. Rollback is disabled without one. */
  sessionId: string | null;
  /** Repository the commit is read from; falls back to the recorded path. */
  repoPath: string | null;
  excludePatterns?: string[];
  className?: string;
}

export function DeployHistoryPanel({
  sessionId,
  repoPath,
  excludePatterns,
  className,
}: DeployHistoryPanelProps) {
  const { t, locale } = useT();
  const { toast, showError } = useToast();
  const dateFormat = useSettingsStore((s) => s.dateFormat);

  const [records, setRecords] = useState<DeployRecord[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);

  const [target, setTarget] = useState<DeployRecord | null>(null);
  const [fullTree, setFullTree] = useState(false);
  const [force, setForce] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRecords(await call<DeployRecord[]>('list_deploy_history', { limit: HISTORY_LIMIT }));
    } catch (e) {
      setRecords(null);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rollback = useCallback(async () => {
    if (!target) return;
    setRollingBack(true);
    try {
      const args: RollbackArgs = {
        recordId: target.id,
        sessionId,
        repoPath: repoPath ?? target.repoPath,
        excludePatterns: excludePatterns ?? null,
        fullTree,
        force,
        dryRun: false,
        deployId: crypto.randomUUID(),
      };
      // `rollback_deploy` takes its arguments flat, not wrapped in `{ args }`.
      const outcome = await call<DeployOutcome>('rollback_deploy', { ...args });
      toast({
        title: t('history.rollbackDone', { commit: target.commitSha.slice(0, 8) }),
        description: t('deploy.planUploads', { count: outcome.uploaded }),
        variant: outcome.success ? 'ok' : 'warn',
      });
      setTarget(null);
      await load();
    } catch (e) {
      showError(e, 'history.rollbackFailed');
    } finally {
      setRollingBack(false);
    }
  }, [excludePatterns, force, fullTree, load, repoPath, sessionId, showError, t, target, toast]);

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex h-toolbar flex-none items-center gap-2 border-b border-border bg-surface-2 px-2">
        <Icon name="clock" className="flex-none text-text-3" />
        <h3 className="text-sm font-semibold tracking-tight text-text">{t('history.title')}</h3>
        {records ? <span className="text-xs tnum text-text-3">{records.length}</span> : null}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="press"
          icon={<Icon name="refresh" />}
          loading={loading}
          onClick={() => void load()}
        >
          {t('history.refresh')}
        </Button>
      </div>

      {error ? (
        <ErrorState
          error={error}
          title={t('history.loadFailed')}
          compact
          onRetry={() => void load()}
        />
      ) : records === null ? (
        <p className="flex items-center gap-1.5 p-4 text-sm text-text-3">
          <Spinner /> {t('common.loading')}
        </p>
      ) : records.length === 0 ? (
        <EmptyState icon="clock" title={t('history.empty')} compact />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-base">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr className="text-2xs uppercase tracking-wider text-text-3">
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-left font-normal"
                >
                  {t('history.columnWhen')}
                </th>
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-left font-normal"
                >
                  {t('history.columnTarget')}
                </th>
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-left font-normal"
                >
                  {t('history.columnBranch')}
                </th>
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-left font-normal"
                >
                  {t('history.columnCommit')}
                </th>
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-right font-normal"
                >
                  {t('history.columnFiles')}
                </th>
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-right font-normal"
                >
                  {t('history.columnDuration')}
                </th>
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-left font-normal"
                >
                  {t('history.columnOutcome')}
                </th>
                <th
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-right font-normal"
                >
                  {t('transfer.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr
                  key={record.id}
                  className="h-row border-t border-border transition-quick hover:bg-surface-2"
                >
                  <td className="whitespace-nowrap px-2 tnum text-text-2">
                    {formatDate(record.timestamp, locale, dateFormat)}
                  </td>
                  <td className="max-w-[220px] px-2">
                    <Tooltip content={record.remoteBasePath} mono>
                      <span className="block truncate font-mono text-sm text-text">
                        {record.serverUser}@{record.serverHost}
                        <span className="text-text-3">:{record.remoteBasePath}</span>
                      </span>
                    </Tooltip>
                  </td>
                  <td className="px-2 font-mono text-sm text-text-2">{record.branch}</td>
                  <td className="px-2 font-mono text-sm text-text-2">
                    {record.commitSha.slice(0, 8)}
                  </td>
                  <td className="whitespace-nowrap px-2 text-right tnum text-text-2">
                    <Tooltip content={t('deploy.planBytes', { size: formatBytes(record.bytes) })}>
                      <span>
                        {t('history.uploadedDeleted', {
                          uploaded: record.filesUploaded.length,
                          deleted: record.filesDeleted.length,
                        })}
                      </span>
                    </Tooltip>
                  </td>
                  <td className="whitespace-nowrap px-2 text-right tnum text-text-2">
                    {formatEta(record.durationMs / 1000)}
                  </td>
                  <td className="px-2">
                    {record.success ? (
                      <span className="inline-flex flex-none items-center rounded-sm bg-ok-weak px-1.5 py-px text-2xs uppercase tracking-wider text-ok">
                        {t('history.outcomeSuccess')}
                      </span>
                    ) : (
                      <Tooltip content={record.error ?? t('history.outcomeFailure')}>
                        <span className="inline-flex flex-none items-center gap-1 rounded-sm bg-danger-weak px-1.5 py-px text-2xs uppercase tracking-wider text-danger">
                          <Icon name="alert-circle" />
                          {t('history.outcomeFailure')}
                        </span>
                      </Tooltip>
                    )}
                  </td>
                  <td className="px-2 text-right">
                    <Button
                      size="sm"
                      className="press"
                      icon={<Icon name="arrow-left" />}
                      disabled={!sessionId || record.commitSha === ''}
                      onClick={() => {
                        setFullTree(false);
                        setForce(false);
                        setTarget(record);
                      }}
                    >
                      {t('history.rollback')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={t('history.rollbackTitle')}
        description={t('history.rollbackWhatItDoes', {
          commit: target?.commitSha.slice(0, 8) ?? '',
        })}
        confirmLabel={t('history.rollbackConfirm', {
          commit: target?.commitSha.slice(0, 8) ?? '',
        })}
        loading={rollingBack}
        onConfirm={() => void rollback()}
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2.5 rounded border border-border bg-warn-weak p-2.5">
            <Icon name="alert-triangle" size={16} className="mt-px flex-none text-warn" />
            <p className="min-w-0 select-text text-sm text-text">{t('history.rollbackCaveats')}</p>
          </div>
          <Checkbox
            checked={fullTree}
            onCheckedChange={setFullTree}
            label={t('history.rollbackFullTree')}
            hint={t('history.rollbackFullTreeHint')}
          />
          <Checkbox
            checked={force}
            onCheckedChange={setForce}
            label={t('history.rollbackForce')}
            hint={t('history.rollbackForceHint')}
          />
          {rollingBack ? (
            <p className="text-sm text-text-3">{t('history.rollbackRunning')}</p>
          ) : null}
        </div>
      </AlertDialog>
    </div>
  );
}
