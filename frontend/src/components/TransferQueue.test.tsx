import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../lib/i18n';
import type { TransferItem, TransferStatus } from '../lib/types';
import { useTransferStore } from '../store/transferStore';
import { ToastProvider, TooltipProvider } from './ui';
import {
  TransferQueue,
  buildRows,
  canCancel,
  canPause,
  canResume,
  canRetry,
  deriveRow,
  totalsFor,
} from './TransferQueue';

// @tanstack/react-virtual needs a ResizeObserver, which jsdom does not have.
// A no-op stub is enough: jsdom reports every element as zero-sized, so the
// virtualizer's visible range stays empty and individual rows never mount. Row
// behaviour is therefore asserted through the pure derivation functions above,
// which is where all of it actually lives; the render tests below cover the
// header, the empty state and the failure state.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver);

function item(overrides: Partial<TransferItem> = {}): TransferItem {
  return {
    id: 'a',
    sessionId: 's1',
    direction: 'download',
    localPath: 'C:\\tmp\\a.txt',
    remotePath: '/srv/a.txt',
    fileName: 'a.txt',
    bytesDone: 0,
    bytesTotal: 0,
    speedBps: 0,
    etaSecs: null,
    status: 'queued',
    error: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const ALL_STATUSES: TransferStatus[] = [
  'queued',
  'active',
  'paused',
  'done',
  'error',
  'cancelled',
  'skipped',
];

describe('pause eligibility', () => {
  it('offers Pause only for a queued item', () => {
    // The backend rejects `pause_transfer` for anything in flight by design:
    // FTP and SFTP cannot suspend a data channel.
    const pausable = ALL_STATUSES.filter((status) => canPause(item({ status })));
    expect(pausable).toEqual(['queued']);
  });

  it('offers Cancel for anything still in the queue, in flight included', () => {
    const cancellable = ALL_STATUSES.filter((status) => canCancel(item({ status })));
    expect(cancellable).toEqual(['queued', 'active', 'paused']);
  });

  it('offers Resume only for a paused item', () => {
    expect(ALL_STATUSES.filter((status) => canResume(item({ status })))).toEqual(['paused']);
  });

  it('offers Retry only for a run that stopped without finishing', () => {
    expect(ALL_STATUSES.filter((status) => canRetry(item({ status })))).toEqual([
      'error',
      'cancelled',
    ]);
  });
});

describe('deriveRow', () => {
  it('goes indeterminate rather than inventing a percentage', () => {
    const row = deriveRow(item({ status: 'active', bytesDone: 500, bytesTotal: 0 }));
    expect(row.ratio).toBeNull();
    expect(row.percent).toBe('\u2014');
    // Without a total, only what has moved so far can be stated.
    expect(row.transferred).toBe('500 B');
  });

  it('reports progress, speed and ETA for an active transfer', () => {
    const row = deriveRow(
      item({
        status: 'active',
        bytesDone: 512 * 1024,
        bytesTotal: 1024 * 1024,
        speedBps: 1024 * 1024,
        etaSecs: 75,
      }),
    );
    expect(row.ratio).toBeCloseTo(0.5);
    expect(row.percent).toBe('50%');
    expect(row.transferred).toBe('512.0 KB / 1.0 MB');
    expect(row.speed).toBe('1.0 MB/s');
    expect(row.eta).toBe('1m 15s');
    expect(row.progressTone).toBe('info');
  });

  it('blanks speed and ETA for anything not actively moving bytes', () => {
    const row = deriveRow(item({ status: 'queued', speedBps: 9999, etaSecs: 10 }));
    expect(row.speed).toBe('\u2014');
    expect(row.eta).toBe('\u2014');
  });

  it('shows a finished transfer as complete even with no known total', () => {
    const row = deriveRow(item({ status: 'done', bytesDone: 10, bytesTotal: 0 }));
    expect(row.ratio).toBe(1);
    expect(row.percent).toBe('100%');
  });

  it('carries the failure reason through', () => {
    const row = deriveRow(item({ status: 'error', error: '550 Permission denied' }));
    expect(row.error).toBe('550 Permission denied');
    expect(row.retryable).toBe(true);
    expect(row.statusTone).toBe('danger');
  });
});

describe('buildRows', () => {
  const label = (id: string) => `label:${id}`;

  it('does not add group headings for a single server', () => {
    const rows = buildRows([item({ id: '1' }), item({ id: '2' })], label);
    expect(rows.every((row) => row.kind === 'item')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('groups by server once more than one is involved', () => {
    const rows = buildRows(
      [
        item({ id: '1', sessionId: 's1' }),
        item({ id: '2', sessionId: 's2' }),
        item({ id: '3', sessionId: 's1' }),
      ],
      label,
    );
    expect(rows.map((row) => row.kind)).toEqual([
      'group',
      'item',
      'item',
      'group',
      'item',
    ]);
    const first = rows[0];
    expect(first.kind === 'group' && first.label).toBe('label:s1');
    expect(first.kind === 'group' && first.count).toBe(2);
  });
});

describe('totalsFor', () => {
  it('counts by status and sums only live bytes', () => {
    const totals = totalsFor([
      item({ id: '1', status: 'active', bytesDone: 50, bytesTotal: 100, speedBps: 10 }),
      item({ id: '2', status: 'queued', bytesTotal: 100 }),
      item({ id: '3', status: 'done', bytesDone: 999, bytesTotal: 999 }),
    ]);
    expect(totals.active).toBe(1);
    expect(totals.queued).toBe(1);
    expect(totals.finished).toBe(1);
    expect(totals.speedBps).toBe(10);
    // 50 of 200 live bytes — the finished 999 is excluded so a long session does
    // not pin the header bar near 100%.
    expect(totals.progress).toBeCloseTo(0.25);
  });

  it('reports null progress when no live total is known', () => {
    expect(totalsFor([item({ status: 'active' })]).progress).toBeNull();
  });
});

function renderQueue() {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ToastProvider>
          <TransferQueue />
        </ToastProvider>
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe('<TransferQueue />', () => {
  beforeEach(() => {
    useTransferStore.setState({
      items: {},
      order: [],
      queuePaused: false,
      hydrated: true,
      error: null,
    });
  });

  it('states an empty queue instead of occupying space with a placeholder', () => {
    renderQueue();
    expect(screen.getByText('Queue empty')).toBeInTheDocument();
    expect(screen.getByText('No transfers')).toBeInTheDocument();
  });

  it('summarises live work in the header', () => {
    const active = item({
      id: '1',
      status: 'active',
      bytesDone: 512,
      bytesTotal: 1024,
      speedBps: 1024,
    });
    useTransferStore.setState({
      items: { '1': active, '2': item({ id: '2' }) },
      order: ['1', '2'],
      hydrated: true,
    });
    renderQueue();
    expect(screen.getByText('1 active, 1 queued · 1.0 KB/s')).toBeInTheDocument();
  });

  it('renders an error state, never an empty state, when hydration failed', () => {
    useTransferStore.setState({
      items: {},
      order: [],
      hydrated: true,
      error: { code: 'internal', message: 'boom' },
    });
    renderQueue();
    expect(screen.getByText('The transfer queue could not be read.')).toBeInTheDocument();
    expect(screen.queryByText('No transfers')).toBeNull();
  });
});
