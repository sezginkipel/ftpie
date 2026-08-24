/* eslint-disable react-refresh/only-export-components */
/**
 * TransferQueue — the real thing.
 *
 * The old component was a 21-line placeholder that occupied 120px forever and
 * showed the string "No active transfers"; there was no progress, no speed, no
 * cancel and no error. This one is driven entirely by `transferStore`.
 *
 * ## Props (F2 reads this)
 * ```tsx
 * <TransferQueue />                       // reads uiStore for collapsed/height
 * <TransferQueue className="border-t" />
 * ```
 * Everything else comes from stores: `transferStore` for rows, `sessionStore`
 * for the per-server group labels, `settingsStore` for the concurrency box and
 * `uiStore` for the collapsed state and the remembered height. There is no
 * imperative API — mount it and it works.
 *
 * ## Two backend facts shape this UI
 * 1. `pause_transfer` **rejects for an in-flight transfer by design** — FTP and
 *    SFTP cannot suspend a data channel. Pause is therefore offered only while
 *    an item is still `queued`; an `active` item gets Cancel.
 * 2. Raising `maxConcurrentTransfers` parallelizes across *different sessions*
 *    only, because one session has a single control connection. The hint says
 *    exactly that instead of implying a single file gets faster.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useMemo, useRef } from 'react';

import { cn } from '../lib/cn';
import {
  DASH,
  formatBytes,
  formatPercent,
  formatSpeed,
  formatEta,
  progressRatio,
  truncateMiddle,
} from '../lib/format';
import { useT, type TFunction } from '../lib/i18n';
import { call } from '../lib/ipc';
import type { EnqueueRequest, TransferItem, TransferStatus } from '../lib/types';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useTransferStore } from '../store/transferStore';
import { useUiStore } from '../store/uiStore';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  NumberInput,
  Spinner,
  Tooltip,
  useToast,
  type BadgeTone,
  type ProgressTone,
} from './ui';

// ── Row derivation (pure, tested) ────────────────────────────────────────────

/**
 * Pause is only ever offered for a `queued` item: the backend refuses to pause
 * something already in flight, and a button that reports an error when clicked
 * is worse than no button.
 */
export function canPause(item: TransferItem): boolean {
  return item.status === 'queued';
}

export function canResume(item: TransferItem): boolean {
  return item.status === 'paused';
}

/** Cancel covers everything still in the queue, in flight included. */
export function canCancel(item: TransferItem): boolean {
  return item.status === 'queued' || item.status === 'active' || item.status === 'paused';
}

/** Retry re-enqueues; only a run that stopped without finishing offers it. */
export function canRetry(item: TransferItem): boolean {
  return item.status === 'error' || item.status === 'cancelled';
}

const STATUS_TONE: Record<TransferStatus, BadgeTone> = {
  queued: 'neutral',
  active: 'info',
  paused: 'warn',
  done: 'ok',
  error: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
};

const PROGRESS_TONE: Record<TransferStatus, ProgressTone> = {
  queued: 'accent',
  active: 'info',
  paused: 'warn',
  done: 'ok',
  error: 'danger',
  cancelled: 'warn',
  skipped: 'warn',
};

/** Everything one row renders, derived once so the row component stays dumb. */
export interface TransferRowView {
  id: string;
  sessionId: string;
  fileName: string;
  /** Full remote path — shown in the tooltip, never truncated there. */
  remotePath: string;
  localPath: string;
  direction: TransferItem['direction'];
  status: TransferStatus;
  /** `null` when the size was never known — the bar goes indeterminate. */
  ratio: number | null;
  percent: string;
  transferred: string;
  speed: string;
  eta: string;
  statusTone: BadgeTone;
  progressTone: ProgressTone;
  error: string | null;
  pausable: boolean;
  resumable: boolean;
  cancellable: boolean;
  retryable: boolean;
}

/**
 * Derive a row's display values.
 *
 * Deliberate honesty: an unknown total (`bytesTotal === 0`) yields
 * `ratio: null` and a dash for the percentage rather than a made-up number, and
 * speed/ETA are blank for anything that is not actively moving bytes.
 */
export function deriveRow(item: TransferItem): TransferRowView {
  const moving = item.status === 'active';
  return {
    id: item.id,
    sessionId: item.sessionId,
    fileName: item.fileName,
    remotePath: item.remotePath,
    localPath: item.localPath,
    direction: item.direction,
    status: item.status,
    ratio: item.status === 'done' ? 1 : progressRatio(item.bytesDone, item.bytesTotal),
    percent: item.status === 'done' ? '100%' : formatPercent(item.bytesDone, item.bytesTotal),
    transferred:
      item.bytesTotal > 0
        ? `${formatBytes(item.bytesDone)} / ${formatBytes(item.bytesTotal)}`
        : formatBytes(item.bytesDone),
    speed: moving ? formatSpeed(item.speedBps) : DASH,
    eta: moving ? formatEta(item.etaSecs) : DASH,
    statusTone: STATUS_TONE[item.status],
    progressTone: PROGRESS_TONE[item.status],
    error: item.error,
    pausable: canPause(item),
    resumable: canResume(item),
    cancellable: canCancel(item),
    retryable: canRetry(item),
  };
}

/** A group heading or one transfer — the flat list the virtualizer walks. */
export type QueueRow =
  | { kind: 'group'; id: string; sessionId: string; label: string; count: number }
  | { kind: 'item'; id: string; view: TransferRowView };

/**
 * Flatten items into rows, inserting a heading per server when more than one
 * server has transfers. With a single server the headings would be noise.
 */
export function buildRows(
  items: TransferItem[],
  labelFor: (sessionId: string) => string,
): QueueRow[] {
  const sessionIds: string[] = [];
  for (const item of items) {
    if (!sessionIds.includes(item.sessionId)) sessionIds.push(item.sessionId);
  }

  if (sessionIds.length <= 1) {
    return items.map((item) => ({ kind: 'item', id: item.id, view: deriveRow(item) }));
  }

  const rows: QueueRow[] = [];
  for (const sessionId of sessionIds) {
    const owned = items.filter((item) => item.sessionId === sessionId);
    rows.push({
      kind: 'group',
      id: `group:${sessionId}`,
      sessionId,
      label: labelFor(sessionId),
      count: owned.length,
    });
    for (const item of owned) {
      rows.push({ kind: 'item', id: item.id, view: deriveRow(item) });
    }
  }
  return rows;
}

/** Header totals. Mirrors `transferStore.aggregates()` but as a pure function
 * of a list, so it can live inside a `useMemo` without lying to the linter. */
export interface QueueTotals {
  active: number;
  queued: number;
  finished: number;
  speedBps: number;
  /** Fraction in `[0, 1]`, or `null` when no unfinished total is known. */
  progress: number | null;
}

export function totalsFor(items: TransferItem[]): QueueTotals {
  let active = 0;
  let queued = 0;
  let finished = 0;
  let speedBps = 0;
  let bytesDone = 0;
  let bytesTotal = 0;

  for (const item of items) {
    if (item.status === 'active') {
      active += 1;
      speedBps += item.speedBps;
    } else if (item.status === 'queued') {
      queued += 1;
    }
    if (isFinished(item.status)) {
      finished += 1;
    } else {
      // Only live work counts toward the header bar, so a long session does
      // not pin it near 100% forever.
      bytesDone += item.bytesDone;
      bytesTotal += item.bytesTotal;
    }
  }

  return {
    active,
    queued,
    finished,
    speedBps,
    progress: bytesTotal > 0 ? Math.min(1, bytesDone / bytesTotal) : null,
  };
}

function isFinished(status: TransferStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled' || status === 'skipped';
}

const GROUP_ROW_H = 26;
const ITEM_ROW_H = 34;

function statusLabel(t: TFunction, status: TransferStatus): string {
  switch (status) {
    case 'queued':
      return t('transfer.status.queued');
    case 'active':
      return t('transfer.status.active');
    case 'paused':
      return t('transfer.status.paused');
    case 'done':
      return t('transfer.status.done');
    case 'error':
      return t('transfer.status.error');
    case 'cancelled':
      return t('transfer.status.cancelled');
    case 'skipped':
      return t('transfer.status.skipped');
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export interface TransferQueueProps {
  className?: string;
}

export function TransferQueue({ className }: TransferQueueProps) {
  const { t } = useT();
  const { toast, showError } = useToast();

  const items = useTransferStore((s) => s.items);
  const order = useTransferStore((s) => s.order);
  const queuePaused = useTransferStore((s) => s.queuePaused);
  const hydrated = useTransferStore((s) => s.hydrated);
  const hydrateError = useTransferStore((s) => s.error);

  const sessions = useSessionStore((s) => s.sessions);
  const collapsed = useUiStore((s) => s.transfersCollapsed);
  const setCollapsed = useUiStore((s) => s.setTransfersCollapsed);
  const height = useUiStore((s) => s.transfersHeight);
  const maxConcurrent = useSettingsStore((s) => s.maxConcurrentTransfers);
  const setSetting = useSettingsStore((s) => s.set);

  const list = useMemo(
    () => order.map((id) => items[id]).filter((i): i is TransferItem => Boolean(i)),
    [order, items],
  );

  const aggregates = useMemo(() => totalsFor(list), [list]);

  const labelFor = useCallback(
    (sessionId: string) => {
      const meta = sessions[sessionId];
      return meta
        ? t('status.connectedAs', { username: meta.username, host: meta.host })
        : t('transfer.sessionUnknown');
    },
    [sessions, t],
  );

  const rows = useMemo(() => buildRows(list, labelFor), [list, labelFor]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? GROUP_ROW_H : ITEM_ROW_H),
    overscan: 12,
  });

  const retry = useCallback(
    async (view: TransferRowView) => {
      try {
        const request: EnqueueRequest = {
          sessionId: view.sessionId,
          items: [
            {
              direction: view.direction,
              localPath: view.localPath,
              remotePath: view.remotePath,
              isDir: false,
              onConflict: 'overwrite',
            },
          ],
        };
        await call<string[]>('enqueue_transfers', { request });
        toast({ title: t('transfer.retried'), variant: 'ok' });
      } catch (error) {
        showError(error, 'transfer.enqueueFailed');
      }
    },
    [showError, t, toast],
  );

  const runCommand = useCallback(
    async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        showError(error);
      }
    },
    [showError],
  );

  const summary = useMemo(() => {
    if (list.length === 0) return t('transfer.emptySummary');
    if (aggregates.active > 0 || aggregates.queued > 0) {
      return t('transfer.summary', {
        active: aggregates.active,
        queued: aggregates.queued,
        speed: formatSpeed(aggregates.speedBps),
      });
    }
    return t('transfer.summaryIdle', { done: aggregates.finished });
  }, [aggregates, list.length, t]);

  const percentText =
    aggregates.progress === null ? DASH : `${Math.round(aggregates.progress * 100)}%`;
  const live = aggregates.active + aggregates.queued > 0;

  return (
    <section
      className={cn('flex flex-none flex-col border-t border-border bg-bg', className)}
      aria-label={t('transfer.title')}
    >
      {/*
       * Header. Chrome, not content: one surface step above the rows with a
       * hairline underneath. The controls are deliberately unequal — pausing the
       * queue carries the weight, clearing finished rows is quiet.
       */}
      <div className="flex h-toolbar flex-none items-center gap-2.5 bg-surface-2 px-2">
        <IconButton
          label={collapsed ? t('transfer.expand') : t('transfer.collapse')}
          icon={<Icon name={collapsed ? 'chevron-up' : 'chevron-down'} />}
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          className="press"
        />

        <div className="flex flex-none items-baseline gap-1.5">
          <span className="text-sm font-semibold tracking-tight text-text">
            {t('transfer.title')}
          </span>
          {list.length > 0 ? <span className="text-xs tnum text-text-3">{list.length}</span> : null}
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {live ? (
            <span className="flex w-[200px] flex-none items-center gap-2">
              <TransferBar
                ratio={aggregates.progress}
                label={t('transfer.queueProgress')}
                tone={queuePaused ? 'warn' : 'info'}
                sheen={!queuePaused && aggregates.active > 0}
                height="md"
              />
              <span className="w-9 flex-none text-right text-xs tnum text-text-2">
                {percentText}
              </span>
            </span>
          ) : null}
          <span className="truncate text-sm tnum text-text-2">{summary}</span>
          {queuePaused ? (
            <span className="flex-none rounded-sm bg-warn-weak px-1.5 py-px text-2xs uppercase tracking-wider text-warn">
              {t('transfer.queuePaused')}
            </span>
          ) : null}
        </div>

        <div
          className="flex flex-none items-center gap-2"
          role="group"
          aria-label={t('transfer.controls')}
        >
          <label className="flex flex-none items-center gap-1.5 text-xs text-text-3">
            <span className="hidden uppercase tracking-wider md:inline">
              {t('transfer.concurrency')}
            </span>
            <Tooltip content={t('transfer.concurrencySessionsNote')}>
              <NumberInput
                value={maxConcurrent}
                onValueChange={(value) =>
                  setSetting({ maxConcurrentTransfers: value ?? maxConcurrent })
                }
                min={1}
                max={16}
                className="w-14"
                aria-label={t('transfer.concurrency')}
              />
            </Tooltip>
          </label>

          <span aria-hidden="true" className="h-5 w-px flex-none bg-border" />

          <Button
            size="sm"
            variant={queuePaused ? 'primary' : 'secondary'}
            className="press"
            icon={<Icon name={queuePaused ? 'play' : 'pause'} />}
            onClick={() =>
              void runCommand(() => useTransferStore.getState().setQueuePaused(!queuePaused))
            }
          >
            {queuePaused ? t('transfer.resumeQueue') : t('transfer.pauseQueue')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="press"
            icon={<Icon name="trash" />}
            disabled={aggregates.finished === 0}
            onClick={() => void runCommand(() => useTransferStore.getState().clearFinished())}
          >
            {t('transfer.clearFinished')}
          </Button>
        </div>
      </div>

      {/* ── Body ── */}
      {collapsed ? null : (
        <div
          className="flex flex-none flex-col border-t border-border bg-surface"
          style={{ height }}
        >
          {hydrateError ? (
            <ErrorState
              error={hydrateError}
              title={t('transfer.hydrateFailed')}
              compact
              onRetry={() => {
                void useTransferStore
                  .getState()
                  .hydrate()
                  .catch(() => {});
              }}
            />
          ) : list.length === 0 ? (
            hydrated ? (
              <EmptyState
                icon="upload"
                title={t('transfer.empty')}
                description={t('transfer.emptyHint')}
                compact
              />
            ) : (
              <p className="flex items-center justify-center gap-2 p-4 text-sm text-text-3">
                <Spinner /> {t('common.loading')}
              </p>
            )
          ) : (
            <>
              <div
                role="row"
                className="flex h-6 flex-none items-center gap-2.5 border-b border-border px-2 text-2xs uppercase tracking-wider text-text-3"
              >
                <span className="w-5 flex-none" aria-hidden="true" />
                <span className="min-w-0 flex-1">{t('transfer.columnName')}</span>
                <span className="w-[132px] flex-none">{t('transfer.columnProgress')}</span>
                <span className="w-32 flex-none text-right">{t('transfer.columnTransferred')}</span>
                <span className="w-20 flex-none text-right">{t('transfer.columnSpeed')}</span>
                <span className="w-16 flex-none text-right">{t('transfer.columnEta')}</span>
                <span className="w-24 flex-none">{t('transfer.columnStatus')}</span>
                <span className="w-[84px] flex-none text-right">{t('transfer.actions')}</span>
              </div>

              <div
                ref={scrollRef}
                className="min-h-0 flex-1 overflow-auto"
                role="rowgroup"
                aria-label={t('transfer.rows')}
              >
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const row = rows[virtualRow.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.id}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: virtualRow.size,
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        {row.kind === 'group' ? (
                          <div className="flex h-full items-center gap-2 bg-surface-2 px-2">
                            <Icon name="server" className="flex-none text-text-3" />
                            <span className="truncate font-mono text-xs text-text-2">
                              {row.label}
                            </span>
                            <span className="text-2xs tnum uppercase tracking-wider text-text-3">
                              {t('common.items', { count: row.count })}
                            </span>
                          </div>
                        ) : (
                          <TransferRow
                            view={row.view}
                            onCancel={() =>
                              void runCommand(() => useTransferStore.getState().cancel(row.view.id))
                            }
                            onPause={() =>
                              void runCommand(() => useTransferStore.getState().pause(row.view.id))
                            }
                            onResume={() =>
                              void runCommand(() => useTransferStore.getState().resume(row.view.id))
                            }
                            onRetry={() => void retry(row.view)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ── Row chrome ──────────────────────────────────────────────────────────────

const TONE_BG: Record<ProgressTone, string> = {
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  info: 'bg-info',
};

/**
 * The queue's progress bar.
 *
 * `ProgressBar` covers the general case, but a transfer row needs one more
 * thing: while bytes are genuinely moving the bar has to *read* as moving, which
 * is the `animate-sheen` overlay riding across the filled portion. The ARIA
 * contract is the primitive's — `aria-valuenow` only when the total is actually
 * known, `aria-busy` when it is not, never an invented percentage.
 */
function TransferBar({
  ratio,
  label,
  tone,
  sheen,
  height = 'sm',
}: {
  ratio: number | null;
  label: string;
  tone: ProgressTone;
  sheen: boolean;
  height?: 'sm' | 'md';
}) {
  const indeterminate = ratio === null || !Number.isFinite(ratio);
  const percent = indeterminate ? 0 : Math.round(Math.max(0, Math.min(1, ratio)) * 100);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : percent}
      aria-valuetext={indeterminate ? undefined : `${percent}%`}
      aria-busy={indeterminate || undefined}
      className={cn(
        'relative min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2',
        'shadow-[inset_0_0_0_1px_var(--border)]',
        height === 'md' ? 'h-1.5' : 'h-1',
      )}
    >
      {indeterminate ? (
        <div className={cn('absolute inset-y-0 w-1/3 animate-indeterminate', TONE_BG[tone])} />
      ) : (
        <div
          className={cn(
            'relative h-full overflow-hidden rounded-full transition-base',
            TONE_BG[tone],
          )}
          style={{ width: `${percent}%` }}
        >
          {sheen ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-sheen bg-gradient-to-r from-transparent via-white/45 to-transparent"
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Status as a tinted chip rather than coloured text. The `*-weak` background
 * means the state is still legible to a colour-blind reader and on a washed-out
 * display, which a coloured word alone is not.
 */
const STATUS_CHIP: Record<TransferStatus, string> = {
  queued: 'bg-surface-2 text-text-2',
  active: 'bg-info-weak text-info',
  paused: 'bg-warn-weak text-warn',
  done: 'bg-ok-weak text-ok',
  error: 'bg-danger-weak text-danger',
  cancelled: 'bg-surface-2 text-text-3',
  skipped: 'bg-surface-2 text-text-3',
};

interface TransferRowProps {
  view: TransferRowView;
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
}

function TransferRow({ view, onCancel, onPause, onResume, onRetry }: TransferRowProps) {
  const { t } = useT();

  const directionLabel =
    view.direction === 'upload' ? t('transfer.upload') : t('transfer.download');
  const moving = view.status === 'active';

  return (
    <div
      role="row"
      className="group flex h-full items-center gap-2.5 border-b border-border px-2 text-base transition-quick hover:bg-surface-2"
      // A failed row is marked on its edge as well as in its chip, so it can be
      // found while scrolling a long queue.
      style={view.status === 'error' ? { boxShadow: 'inset 2px 0 0 0 var(--danger)' } : undefined}
    >
      <Tooltip content={directionLabel}>
        <span
          className={cn(
            'flex h-5 w-5 flex-none items-center justify-center rounded-sm',
            moving ? 'bg-info-weak text-info' : 'bg-surface-2 text-text-3',
          )}
        >
          <Icon name={view.direction === 'upload' ? 'upload' : 'download'} />
        </span>
      </Tooltip>

      <Tooltip content={view.remotePath} mono>
        <span className="min-w-0 flex-1 truncate font-medium text-text">
          {truncateMiddle(view.fileName, 60)}
        </span>
      </Tooltip>

      <span className="flex w-[132px] flex-none items-center gap-2">
        <TransferBar
          ratio={view.ratio}
          label={view.fileName}
          tone={view.progressTone}
          sheen={moving}
        />
        <span className="w-9 flex-none text-right text-xs tnum text-text-3">{view.percent}</span>
      </span>

      <span className="w-32 flex-none text-right font-mono text-xs tnum text-text-2">
        {view.transferred}
      </span>
      <span
        className={cn(
          'w-20 flex-none text-right font-mono text-xs tnum',
          moving ? 'text-text' : 'text-text-3',
        )}
      >
        {view.speed}
      </span>
      <span
        className={cn(
          'w-16 flex-none text-right font-mono text-xs tnum',
          moving ? 'text-text' : 'text-text-3',
        )}
      >
        {view.eta}
      </span>

      <span className="flex w-24 flex-none items-center gap-1.5">
        <span
          className={cn(
            'inline-flex h-[18px] flex-none items-center rounded-sm px-1.5 text-2xs uppercase tracking-wider',
            STATUS_CHIP[view.status],
          )}
        >
          {statusLabel(t, view.status)}
        </span>
        {view.error ? (
          // The failure reason itself, not a generic "failed" — the old queue
          // dropped it entirely.
          <Tooltip content={view.error} mono>
            <span
              role="note"
              aria-label={view.error}
              className="flex flex-none select-text items-center text-danger"
            >
              <Icon name="alert-circle" />
            </span>
          </Tooltip>
        ) : null}
      </span>

      {/*
       * Actions keep a reserved width and lift to full opacity on hover or
       * focus, so the row never reflows under the pointer and keyboard users
       * still see what they are on.
       */}
      <span className="flex w-[84px] flex-none items-center justify-end gap-0.5 opacity-70 transition-quick focus-within:opacity-100 group-hover:opacity-100">
        {view.retryable ? (
          <IconButton
            label={t('transfer.retry')}
            icon={<Icon name="refresh" />}
            className="press"
            onClick={onRetry}
          />
        ) : null}
        {view.pausable ? (
          <IconButton
            label={t('transfer.pause')}
            icon={<Icon name="pause" />}
            className="press"
            onClick={onPause}
          />
        ) : null}
        {view.resumable ? (
          <IconButton
            label={t('transfer.resume')}
            icon={<Icon name="play" />}
            className="press"
            onClick={onResume}
          />
        ) : null}
        {view.cancellable ? (
          <IconButton
            label={t('transfer.cancel')}
            icon={<Icon name="x" />}
            variant="ghost"
            className="press"
            onClick={onCancel}
          />
        ) : null}
      </span>
    </div>
  );
}
