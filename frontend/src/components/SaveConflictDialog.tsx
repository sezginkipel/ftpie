/* eslint-disable react-refresh/only-export-components */
/**
 * SaveConflictDialog — shown when `editor_save_file` rejects with `conflict`.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <SaveConflictDialog tabId={tabId} remoteHash={hash} onClose={close} />
 * ```
 * `EditorPane` already renders this for `uiStore.dialog.kind === 'saveConflict'`,
 * so the shell does **not** need to mount it a second time.
 *
 * Three exits, all named for what they cost:
 * - **Show differences** — fetches the server's copy and diffs it with
 *   `editor_diff`. Read-only, costs nothing, and is the default suggestion.
 * - **Overwrite the server's version** — saves with `expectedHash` cleared. The
 *   other person's changes are gone.
 * - **Discard my changes and reload** — reverts the tab. Your edits are gone.
 *
 * The diff is rendered from `DiffResult` as plain text rows rather than through
 * Monaco's DiffEditor: the old DiffEditor captured a tab id at mount and never
 * remounted, which let `Ctrl+S` write one file's content over a different
 * remote file. There is no editor instance here at all, so that class of bug
 * cannot come back.
 */
import { useCallback, useMemo, useState } from 'react';

import { formatBytes } from '../lib/format';
import { useT } from '../lib/i18n';
import { call } from '../lib/ipc';
import type { DiffLine, DiffResult, OpenedFile } from '../lib/types';
import { useEditorStore } from '../store/editorStore';
import { Badge, Button, Dialog, Icon, InlineError, Spinner, useToast } from './ui';

// ── Pure decision handling (tested) ─────────────────────────────────────────

export type ConflictDecision = 'overwrite' | 'reload' | 'diff' | 'cancel';

export interface DecisionPlan {
  /** Which store operation the decision maps to. */
  command: 'save-force' | 'revert' | 'diff' | 'none';
  /** True when the server's newer content is discarded. */
  discardsRemote: boolean;
  /** True when the user's unsaved edits are discarded. */
  discardsLocal: boolean;
  /** Whether the dialog closes once the command succeeds. */
  closesDialog: boolean;
}

/**
 * What each choice actually does. Kept pure and explicit so the destructive
 * half of each option is impossible to mislabel in the UI.
 */
export function decisionPlan(decision: ConflictDecision): DecisionPlan {
  switch (decision) {
    case 'overwrite':
      return {
        command: 'save-force',
        discardsRemote: true,
        discardsLocal: false,
        closesDialog: true,
      };
    case 'reload':
      return {
        command: 'revert',
        discardsRemote: false,
        discardsLocal: true,
        closesDialog: true,
      };
    case 'diff':
      return {
        command: 'diff',
        discardsRemote: false,
        discardsLocal: false,
        closesDialog: false,
      };
    case 'cancel':
      return {
        command: 'none',
        discardsRemote: false,
        discardsLocal: false,
        closesDialog: true,
      };
  }
}

/** How many diff rows are rendered before the list is cut off. */
export const DIFF_ROW_LIMIT = 400;

export interface DiffSummary {
  insertions: number;
  deletions: number;
  /** True when the two versions turned out to have no differing lines. */
  identical: boolean;
  lines: DiffLine[];
  /** How many rows were dropped by {@link DIFF_ROW_LIMIT}. */
  truncated: number;
}

/**
 * Reduce a `DiffResult` to what the dialog renders. Equal lines are kept for
 * context but the list is capped — a 200k-line file must not build 200k nodes.
 */
export function summariseDiff(diff: DiffResult): DiffSummary {
  const lines = diff.lines.slice(0, DIFF_ROW_LIMIT);
  return {
    insertions: diff.insertions,
    deletions: diff.deletions,
    identical: diff.insertions === 0 && diff.deletions === 0,
    lines,
    truncated: Math.max(0, diff.lines.length - lines.length),
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export interface SaveConflictDialogProps {
  /** Editor tab whose save was refused. */
  tabId: string;
  /** Hash the server reports now, carried on the `conflict` error. */
  remoteHash?: string | null;
  onClose: () => void;
}

export function SaveConflictDialog({ tabId, remoteHash, onClose }: SaveConflictDialogProps) {
  const { t } = useT();
  const { toast } = useToast();

  const tab = useEditorStore((s) => s.tabs.find((candidate) => candidate.id === tabId) ?? null);

  const [remote, setRemote] = useState<OpenedFile | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [busy, setBusy] = useState<ConflictDecision | null>(null);
  const [error, setError] = useState<unknown>(null);

  const summary = useMemo(() => (diff ? summariseDiff(diff) : null), [diff]);

  const showDiff = useCallback(async () => {
    if (!tab) return;
    setError(null);
    setLoadingDiff(true);
    try {
      const server = await call<OpenedFile>('editor_open_file', {
        sessionId: tab.sessionId,
        remotePath: tab.remotePath,
      });
      setRemote(server);
      if (server.isBinary) {
        // Diffing base64 would be noise, not information.
        setDiff(null);
        return;
      }
      const result = await call<DiffResult>('editor_diff', {
        original: server.content,
        modified: tab.content,
      });
      setDiff(result);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingDiff(false);
    }
  }, [tab]);

  const decide = useCallback(
    async (decision: ConflictDecision) => {
      if (!tab) return;
      const plan = decisionPlan(decision);

      if (plan.command === 'diff') {
        await showDiff();
        return;
      }
      if (plan.command === 'none') {
        onClose();
        return;
      }

      setError(null);
      setBusy(decision);
      try {
        if (plan.command === 'save-force') {
          await useEditorStore.getState().save(tab.id, { force: true });
          toast({ title: t('editor.saved', { name: tab.fileName }), variant: 'ok' });
        } else {
          await useEditorStore.getState().revert(tab.id);
          toast({ title: t('common.reload'), variant: 'info' });
        }
        onClose();
      } catch (e) {
        // The tab stays dirty; the dialog stays open with the reason visible.
        setError(e);
      } finally {
        setBusy(null);
      }
    },
    [onClose, showDiff, t, tab, toast],
  );

  if (!tab) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="xl"
      title={t('saveConflict.title')}
      description={t('saveConflict.body', { name: tab.fileName })}
      headerExtra={
        remoteHash ? (
          <Badge tone="warn" mono>
            {remoteHash.slice(0, 12)}
          </Badge>
        ) : null
      }
      footer={
        <div className="flex w-full items-center gap-2">
          <div className="min-w-0 flex-1">
            {error ? <InlineError error={error} /> : null}
          </div>
          <Button onClick={() => void decide('cancel')}>{t('common.cancel')}</Button>
          <Button
            variant="danger"
            loading={busy === 'reload'}
            icon={<Icon name="download" />}
            onClick={() => void decide('reload')}
          >
            {t('saveConflict.reload')}
          </Button>
          <Button
            variant="danger"
            loading={busy === 'overwrite'}
            icon={<Icon name="upload" />}
            onClick={() => void decide('overwrite')}
          >
            {t('saveConflict.overwrite')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-sm text-text-2">{t('saveConflict.reloadWarning')}</p>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            icon={<Icon name="list" />}
            loading={loadingDiff}
            onClick={() => void decide('diff')}
          >
            {t('saveConflict.showDiff')}
          </Button>
          {summary ? (
            <span className="text-sm tnum text-text-2">
              {t('saveConflict.diffSummary', {
                insertions: summary.insertions,
                deletions: summary.deletions,
              })}
            </span>
          ) : null}
          {remote ? (
            <span className="text-sm tnum text-text-3">
              {t('editor.bytesOnServer', { size: formatBytes(remote.size) })}
            </span>
          ) : null}
        </div>

        {loadingDiff ? (
          <p className="flex items-center gap-1.5 text-sm text-text-3">
            <Spinner /> {t('saveConflict.loadingRemote')}
          </p>
        ) : null}

        {remote?.isBinary ? (
          <p role="note" className="text-sm text-warn">
            {t('editor.binaryBody')}
          </p>
        ) : null}

        {summary?.identical ? (
          <p role="note" className="text-sm text-ok">
            {t('saveConflict.identical')}
          </p>
        ) : null}

        {summary && !summary.identical ? (
          <div className="max-h-[46vh] overflow-auto rounded border border-border bg-surface-2">
            <table className="w-full border-collapse font-mono text-xs">
              <caption className="sr-only">
                {t('saveConflict.diffServer')} / {t('saveConflict.diffMine')}
              </caption>
              <tbody>
                {summary.lines.map((line, index) => (
                  <tr
                    key={`${line.op}-${index}`}
                    className={
                      line.op === 'insert'
                        ? 'text-ok'
                        : line.op === 'delete'
                          ? 'text-danger'
                          : 'text-text-2'
                    }
                  >
                    <td className="w-10 select-none px-1 text-right tnum text-text-3">
                      {line.oldLine ?? ''}
                    </td>
                    <td className="w-10 select-none px-1 text-right tnum text-text-3">
                      {line.newLine ?? ''}
                    </td>
                    <td className="w-4 select-none text-center text-text-3">
                      {line.op === 'insert' ? '+' : line.op === 'delete' ? '-' : ' '}
                    </td>
                    <td className="select-text whitespace-pre-wrap break-all px-1">
                      {line.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summary.truncated > 0 ? (
              <p className="border-t border-border px-2 py-1 text-xs text-text-3">
                {t('saveConflict.diffTruncated', { count: DIFF_ROW_LIMIT })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
