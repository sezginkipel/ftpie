import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearInvokeMocks,
  clearTauriEvents,
  emitTauriEvent,
  invokeCalls,
  listenCounts,
  mockInvoke,
} from '../test/setup';
import type { TransferItem, TransferProgressPatch } from '../lib/types';
import { resetTransferSubscription, useTransferStore } from './transferStore';

function item(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: 't1',
    sessionId: 's1',
    direction: 'download',
    localPath: 'C:\\downloads\\a.zip',
    remotePath: '/var/www/a.zip',
    fileName: 'a.zip',
    bytesDone: 0,
    bytesTotal: 1000,
    speedBps: 0,
    etaSecs: null,
    status: 'queued',
    error: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const store = () => useTransferStore.getState();

beforeEach(() => {
  clearInvokeMocks();
  clearTauriEvents();
  resetTransferSubscription();
  useTransferStore.setState({
    items: {},
    order: [],
    queuePaused: false,
    hydrated: false,
    error: null,
  });
});

describe('applyUpdate — partial payload merging', () => {
  it('merges a throttled patch without clobbering the item’s other fields', () => {
    store().applyUpdate(item());

    const patch: TransferProgressPatch = {
      id: 't1',
      bytesDone: 512,
      bytesTotal: 1000,
      speedBps: 128,
      etaSecs: 4,
      status: 'active',
      partial: true,
    };
    store().applyUpdate(patch);

    const merged = store().items.t1;
    // Progress fields updated...
    expect(merged.bytesDone).toBe(512);
    expect(merged.speedBps).toBe(128);
    expect(merged.etaSecs).toBe(4);
    expect(merged.status).toBe('active');
    // ...and everything the patch does not carry survived. Replacing instead of
    // merging blanked all of these on the first progress tick.
    expect(merged.fileName).toBe('a.zip');
    expect(merged.sessionId).toBe('s1');
    expect(merged.direction).toBe('download');
    expect(merged.localPath).toBe('C:\\downloads\\a.zip');
    expect(merged.remotePath).toBe('/var/www/a.zip');
  });

  it('does not invent a row from a patch for an unknown id', () => {
    store().applyUpdate({
      id: 'ghost',
      bytesDone: 1,
      bytesTotal: 2,
      speedBps: 1,
      etaSecs: null,
      status: 'active',
      partial: true,
    });
    expect(store().order).toEqual([]);
    expect(store().items.ghost).toBeUndefined();
  });

  it('lets a later full item replace a merged one entirely', () => {
    store().applyUpdate(item());
    store().applyUpdate({
      id: 't1',
      bytesDone: 500,
      bytesTotal: 1000,
      speedBps: 100,
      etaSecs: 5,
      status: 'active',
      partial: true,
    });
    store().applyUpdate(item({ status: 'done', bytesDone: 1000, speedBps: 0, finishedAt: 'now' }));

    const done = store().items.t1;
    expect(done.status).toBe('done');
    expect(done.finishedAt).toBe('now');
    expect(done.speedBps).toBe(0);
  });

  it('appends new ids once and keeps arrival order stable across updates', () => {
    store().applyUpdate(item({ id: 'a' }));
    store().applyUpdate(item({ id: 'b' }));
    store().applyUpdate(item({ id: 'a', bytesDone: 10 }));
    expect(store().order).toEqual(['a', 'b']);
  });

  it('ignores a malformed payload rather than throwing', () => {
    store().applyUpdate(undefined as unknown as TransferItem);
    store().applyUpdate({} as TransferItem);
    expect(store().order).toEqual([]);
  });
});

describe('applyRemoved', () => {
  it('drops the item from both the map and the order', () => {
    store().applyUpdate(item({ id: 'a' }));
    store().applyUpdate(item({ id: 'b' }));
    store().applyRemoved('a');
    expect(store().order).toEqual(['b']);
    expect(store().items.a).toBeUndefined();
  });

  it('is a no-op for an unknown id', () => {
    store().applyUpdate(item({ id: 'a' }));
    store().applyRemoved('nope');
    expect(store().order).toEqual(['a']);
  });
});

describe('aggregates', () => {
  it('counts each status and sums the speed of active transfers only', () => {
    store().applyUpdate(item({ id: 'a', status: 'active', speedBps: 100, bytesDone: 500 }));
    store().applyUpdate(item({ id: 'b', status: 'active', speedBps: 200, bytesDone: 250 }));
    store().applyUpdate(item({ id: 'c', status: 'queued' }));
    store().applyUpdate(item({ id: 'd', status: 'paused' }));
    store().applyUpdate(item({ id: 'e', status: 'error', speedBps: 999 }));
    store().applyUpdate(item({ id: 'f', status: 'done', bytesDone: 1000 }));

    const totals = store().aggregates();
    expect(totals.active).toBe(2);
    expect(totals.queued).toBe(1);
    expect(totals.paused).toBe(1);
    expect(totals.failed).toBe(1);
    // 'done' and 'error' are both terminal statuses.
    expect(totals.finished).toBe(2);
    expect(totals.speedBps).toBe(300);
  });

  it('excludes finished work so the aggregate bar does not stick near 100%', () => {
    store().applyUpdate(item({ id: 'a', status: 'done', bytesDone: 1000, bytesTotal: 1000 }));
    store().applyUpdate(item({ id: 'b', status: 'active', bytesDone: 250, bytesTotal: 1000 }));

    const totals = store().aggregates();
    expect(totals.bytesDone).toBe(250);
    expect(totals.bytesTotal).toBe(1000);
    expect(totals.progress).toBeCloseTo(0.25);
  });

  it('reports indeterminate progress when no total is known', () => {
    store().applyUpdate(item({ id: 'a', status: 'active', bytesTotal: 0, bytesDone: 10 }));
    expect(store().aggregates().progress).toBeNull();
  });

  it('is empty-safe', () => {
    const totals = store().aggregates();
    expect(totals.active).toBe(0);
    expect(totals.progress).toBeNull();
  });
});

describe('listForSession', () => {
  it('filters by session so a multi-server queue can be grouped', () => {
    store().applyUpdate(item({ id: 'a', sessionId: 's1' }));
    store().applyUpdate(item({ id: 'b', sessionId: 's2' }));
    expect(
      store()
        .listForSession('s1')
        .map((i) => i.id),
    ).toEqual(['a']);
    expect(
      store()
        .listForSession('s2')
        .map((i) => i.id),
    ).toEqual(['b']);
  });
});

describe('hydrate', () => {
  it('loads the queue from list_transfers', async () => {
    mockInvoke('list_transfers', () => [item({ id: 'a' }), item({ id: 'b' })]);
    await store().hydrate();
    expect(store().order).toEqual(['a', 'b']);
    expect(store().hydrated).toBe(true);
    expect(store().error).toBeNull();
  });

  it('records the error instead of pretending the queue is empty', async () => {
    await expect(store().hydrate()).rejects.toBeTruthy();
    expect(store().hydrated).toBe(true);
    expect(store().error).toBeTruthy();
  });
});

describe('subscribe', () => {
  it('listens to both events exactly once, however often it is called', async () => {
    await store().subscribe();
    await store().subscribe();
    await store().subscribe();

    expect(listenCounts.get('transfer:update')).toBe(1);
    expect(listenCounts.get('transfer:removed')).toBe(1);
  });

  it('routes real events into the store, patches included', async () => {
    await store().subscribe();

    emitTauriEvent('transfer:update', item({ id: 'a' }));
    emitTauriEvent('transfer:update', {
      id: 'a',
      bytesDone: 100,
      bytesTotal: 1000,
      speedBps: 50,
      etaSecs: 18,
      status: 'active',
      partial: true,
    });
    expect(store().items.a.bytesDone).toBe(100);
    expect(store().items.a.fileName).toBe('a.zip');

    emitTauriEvent('transfer:removed', { id: 'a' });
    expect(store().items.a).toBeUndefined();
  });

  it('detaches both listeners when the returned function is called', async () => {
    const unlisten = await store().subscribe();
    unlisten();

    emitTauriEvent('transfer:update', item({ id: 'a' }));
    expect(store().order).toEqual([]);
  });

  it('ignores a removed event with no usable id', async () => {
    await store().subscribe();
    store().applyUpdate(item({ id: 'a' }));
    emitTauriEvent('transfer:removed', {});
    emitTauriEvent('transfer:removed', null);
    expect(store().order).toEqual(['a']);
  });
});

describe('commands', () => {
  it('sends the ids the backend expects', async () => {
    mockInvoke('cancel_transfer', () => null);
    mockInvoke('pause_transfer', () => null);
    mockInvoke('resume_transfer', () => null);
    mockInvoke('set_queue_paused', () => null);

    await store().cancel('t1');
    await store().pause('t2');
    await store().resume('t3');
    await store().setQueuePaused(true);

    expect(invokeCalls).toEqual([
      { cmd: 'cancel_transfer', args: { id: 't1' } },
      { cmd: 'pause_transfer', args: { id: 't2' } },
      { cmd: 'resume_transfer', args: { id: 't3' } },
      { cmd: 'set_queue_paused', args: { paused: true } },
    ]);
    expect(store().queuePaused).toBe(true);
  });

  it('lets a pause rejection through so a stale button reports honestly', async () => {
    // Pausing an in-flight transfer is an error by design backend-side.
    mockInvoke('pause_transfer', () => {
      throw { code: 'config', message: 'cannot pause an active transfer' };
    });
    await expect(store().pause('t1')).rejects.toMatchObject({ code: 'config' });
  });

  it('clearFinished removes exactly the ids the backend reports', async () => {
    store().applyUpdate(item({ id: 'a', status: 'done' }));
    store().applyUpdate(item({ id: 'b', status: 'active' }));
    mockInvoke('clear_finished_transfers', () => ['a']);

    await store().clearFinished();
    expect(store().order).toEqual(['b']);
  });
});
