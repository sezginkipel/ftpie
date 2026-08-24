/**
 * Transfer queue state, driven by the backend's `transfer:update` and
 * `transfer:removed` events.
 *
 * Two things this store exists to get right:
 *
 * 1. **Partial payloads.** While bytes are moving, the backend throttles updates
 *    down to `{id, bytesDone, bytesTotal, speedBps, etaSecs, status:'active',
 *    partial:true}`. That is a *patch*, not an item — merging it as a
 *    replacement would blank out `fileName`, `sessionId`, `direction` and every
 *    path on the very first progress tick.
 * 2. **A single subscription.** `subscribe()` is idempotent and returns an
 *    unlisten function; the two `listen` handles are torn down together.
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { call } from '../lib/ipc';
import {
  isProgressPatch,
  isTerminalStatus,
  type TransferItem,
  type TransferRemovedEvent,
  type TransferUpdatePayload,
} from '../lib/types';

export interface TransferAggregates {
  active: number;
  queued: number;
  paused: number;
  failed: number;
  finished: number;
  /** Sum of `speedBps` across active transfers. */
  speedBps: number;
  bytesDone: number;
  bytesTotal: number;
  /** Overall fraction in `[0, 1]`, or `null` when no total is known. */
  progress: number | null;
}

interface TransferState {
  /** Items keyed by id. */
  items: Record<string, TransferItem>;
  /** Arrival order, so the queue renders stably. */
  order: string[];
  queuePaused: boolean;
  hydrated: boolean;
  /** Set when hydration failed, so the queue can show an ErrorState. */
  error: unknown;

  // ── Reads ──
  list: () => TransferItem[];
  listForSession: (sessionId: string) => TransferItem[];
  aggregates: () => TransferAggregates;

  // ── Event plumbing ──
  /**
   * Attach the two event listeners. Idempotent: calling it twice does not
   * double-subscribe. The returned function detaches them.
   */
  subscribe: () => Promise<UnlistenFn>;
  /** Load the current queue from the backend. */
  hydrate: () => Promise<void>;

  /** Apply one `transfer:update` payload (full item or throttled patch). */
  applyUpdate: (payload: TransferUpdatePayload) => void;
  /** Apply one `transfer:removed` payload. */
  applyRemoved: (id: string) => void;

  // ── Commands ──
  cancel: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  setQueuePaused: (paused: boolean) => Promise<void>;
}

/** A patch for an item we have never seen is held until the full item arrives. */
function mergePayload(
  existing: TransferItem | undefined,
  payload: TransferUpdatePayload,
): TransferItem | null {
  if (!isProgressPatch(payload)) return payload;

  // A progress patch alone cannot construct an item — it has no session, no
  // paths and no file name. Dropping it is correct: the full item is emitted on
  // every state change, so the row appears a beat later with real fields.
  if (!existing) return null;

  return {
    ...existing,
    bytesDone: payload.bytesDone,
    bytesTotal: payload.bytesTotal,
    speedBps: payload.speedBps,
    etaSecs: payload.etaSecs,
    status: payload.status,
  };
}

let unlistenHandles: UnlistenFn[] | null = null;
let subscribing: Promise<UnlistenFn> | null = null;

export const useTransferStore = create<TransferState>((set, get) => ({
  items: {},
  order: [],
  queuePaused: false,
  hydrated: false,
  error: null,

  list() {
    const { order, items } = get();
    return order.map((id) => items[id]).filter((i): i is TransferItem => Boolean(i));
  },

  listForSession(sessionId) {
    return get()
      .list()
      .filter((item) => item.sessionId === sessionId);
  },

  aggregates() {
    const items = get().list();
    const totals: TransferAggregates = {
      active: 0,
      queued: 0,
      paused: 0,
      failed: 0,
      finished: 0,
      speedBps: 0,
      bytesDone: 0,
      bytesTotal: 0,
      progress: null,
    };

    for (const item of items) {
      switch (item.status) {
        case 'active':
          totals.active += 1;
          totals.speedBps += item.speedBps;
          break;
        case 'queued':
          totals.queued += 1;
          break;
        case 'paused':
          totals.paused += 1;
          break;
        case 'error':
          totals.failed += 1;
          break;
        default:
          break;
      }
      if (isTerminalStatus(item.status)) totals.finished += 1;

      // Only unfinished work counts toward the aggregate bar, so a long session
      // does not permanently pin it near 100%.
      if (!isTerminalStatus(item.status)) {
        totals.bytesDone += item.bytesDone;
        totals.bytesTotal += item.bytesTotal;
      }
    }

    totals.progress =
      totals.bytesTotal > 0 ? Math.min(1, totals.bytesDone / totals.bytesTotal) : null;
    return totals;
  },

  async subscribe() {
    if (unlistenHandles) {
      const handles = unlistenHandles;
      return () => detach(handles);
    }
    if (subscribing) return subscribing;

    subscribing = (async () => {
      const update = await listen<TransferUpdatePayload>('transfer:update', (event) => {
        get().applyUpdate(event.payload);
      });
      const removed = await listen<TransferRemovedEvent>('transfer:removed', (event) => {
        const id = event.payload?.id;
        if (typeof id === 'string') get().applyRemoved(id);
      });

      const handles = [update, removed];
      unlistenHandles = handles;
      subscribing = null;
      return () => detach(handles);
    })();

    return subscribing;
  },

  async hydrate() {
    try {
      const live = await call<TransferItem[]>('list_transfers');
      set(() => {
        const items: Record<string, TransferItem> = {};
        for (const item of live) items[item.id] = item;
        return {
          items,
          order: live.map((item) => item.id),
          hydrated: true,
          error: null,
        };
      });
    } catch (error) {
      set({ hydrated: true, error });
      throw error;
    }
  },

  applyUpdate(payload) {
    if (!payload || typeof payload.id !== 'string') return;

    set((state) => {
      const merged = mergePayload(state.items[payload.id], payload);
      if (!merged) return {};

      const known = state.items[payload.id] !== undefined;
      return {
        items: { ...state.items, [merged.id]: merged },
        order: known ? state.order : [...state.order, merged.id],
      };
    });
  },

  applyRemoved(id) {
    set((state) => {
      if (!state.items[id]) return {};
      const items = { ...state.items };
      delete items[id];
      return { items, order: state.order.filter((existing) => existing !== id) };
    });
  },

  async cancel(id) {
    await call<void>('cancel_transfer', { id });
  },

  async pause(id) {
    // Pausing an in-flight transfer is an error by design backend-side; the UI
    // only offers Pause for queued items. Let the rejection through so a stale
    // button reports honestly instead of appearing to work.
    await call<void>('pause_transfer', { id });
  },

  async resume(id) {
    await call<void>('resume_transfer', { id });
  },

  async clearFinished() {
    const removed = await call<string[]>('clear_finished_transfers');
    for (const id of removed) get().applyRemoved(id);
  },

  async setQueuePaused(paused) {
    await call<void>('set_queue_paused', { paused });
    set({ queuePaused: paused });
  },
}));

function detach(handles: UnlistenFn[]): void {
  for (const unlisten of handles) {
    try {
      unlisten();
    } catch {
      // The window may already be tearing down.
    }
  }
  if (unlistenHandles === handles) unlistenHandles = null;
}

/** Test seam: forget the module-level subscription state. */
export function resetTransferSubscription(): void {
  unlistenHandles = null;
  subscribing = null;
}
