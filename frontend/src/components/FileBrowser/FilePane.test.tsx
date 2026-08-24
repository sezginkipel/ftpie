/**
 * Regression tests for the pane's *states*, which is where the old UI was worst:
 * a failed listing rendered as "Empty directory".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../lib/i18n';
import type { RemoteFile } from '../../lib/types';
import { useSettingsStore } from '../../store/settingsStore';
import { ToastProvider, TooltipProvider } from '../ui';
import { FilePane } from './FilePane';
import { mockInvoke } from '../../test/setup';

// jsdom gives every element a zero-height box, which would make the virtualizer
// render no rows at all. Give it a viewport.
beforeAll(() => {
  for (const [property, value] of [
    ['clientHeight', 600],
    ['offsetHeight', 600],
    ['clientWidth', 900],
    ['offsetWidth', 900],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, property, {
      configurable: true,
      value,
    });
  }
  HTMLElement.prototype.getBoundingClientRect = function getRect() {
    return {
      width: 900,
      height: 600,
      top: 0,
      left: 0,
      right: 900,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

function remote(name: string, overrides: Partial<RemoteFile> = {}): RemoteFile {
  return {
    name,
    path: `/srv/${name}`,
    size: 100,
    isDir: false,
    isSymlink: false,
    symlinkTarget: null,
    permissions: 'rw-r--r--',
    mode: 0o644,
    modified: '2026-08-01T10:00:00Z',
    owner: 'root',
    group: 'root',
    ...overrides,
  };
}

interface HarnessOptions {
  selection?: string[];
  onSelectionChange?: (paths: string[]) => void;
  onNavigate?: (path: string) => void;
}

function renderPane(options: HarnessOptions = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });

  const props = {
    side: 'remote' as const,
    sessionId: 's1',
    path: '/srv',
    onNavigate: options.onNavigate ?? vi.fn(),
    sort: { key: 'name' as const, direction: 'asc' as const },
    onSortChange: vi.fn(),
    selection: options.selection ?? [],
    onSelectionChange: options.onSelectionChange ?? vi.fn(),
    focused: true,
    onFocus: vi.fn(),
    onTransfer: vi.fn(),
    onReceive: vi.fn(),
    onOpenFile: vi.fn(),
    onSwitchPane: vi.fn(),
  };

  const utils = render(
    <I18nProvider locale="en">
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ToastProvider>
            <FilePane {...props} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...utils, props };
}

beforeEach(() => {
  useSettingsStore.setState({ showHiddenFiles: false, dateFormat: 'iso' });
});

describe('FilePane states', () => {
  it('renders a real error state, never "this folder is empty", when listing fails', async () => {
    mockInvoke('list_remote', () => {
      throw { code: 'permission', message: 'EACCES on /srv' };
    });

    renderPane();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('does not have permission');
    // The single most misleading bug in the old UI.
    expect(screen.queryByText('This folder is empty')).toBeNull();
    // The raw backend detail is reachable, and so is Retry.
    expect(within(alert).getByRole('button', { name: 'Show details' })).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('distinguishes a genuinely empty folder from a failure', async () => {
    mockInvoke('list_remote', () => []);
    renderPane();

    expect(await screen.findByText('This folder is empty')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders rows in a grid, folders first', async () => {
    mockInvoke('list_remote', () => [
      remote('zeta.txt'),
      remote('alpha', { isDir: true, path: '/srv/alpha' }),
    ]);

    renderPane();

    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    const rows = screen.getAllByRole('row');
    // Row 0 is the header.
    expect(rows[1]).toHaveTextContent('alpha');
    expect(rows[2]).toHaveTextContent('zeta.txt');
  });

  it('hides dotfiles in the remote pane until showHiddenFiles is on', async () => {
    mockInvoke('list_remote', () => [remote('.env'), remote('visible.txt')]);

    const { unmount } = renderPane();
    // Header + one visible row.
    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(2));
    expect(screen.queryByText('.env')).toBeNull();
    unmount();

    useSettingsStore.setState({ showHiddenFiles: true });
    renderPane();
    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(3));
    expect(screen.getByText('.env')).toBeTruthy();
  });

  it('moves the selection with the arrow keys and extends it with Shift', async () => {
    mockInvoke('list_remote', () => [remote('a.txt'), remote('b.txt'), remote('c.txt')]);

    const onSelectionChange = vi.fn();
    renderPane({ onSelectionChange });

    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(4));
    const grid = screen.getByRole('grid');
    grid.focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(onSelectionChange).toHaveBeenLastCalledWith(['/srv/a.txt']);
  });

  it('navigates up on Backspace', async () => {
    mockInvoke('list_remote', () => [remote('a.txt')]);
    const onNavigate = vi.fn();
    renderPane({ onNavigate });

    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(2));
    screen.getByRole('grid').focus();
    await userEvent.keyboard('{Backspace}');
    expect(onNavigate).toHaveBeenCalledWith('/');
  });

  it('exposes sortable column headers with aria-sort', async () => {
    mockInvoke('list_remote', () => []);
    renderPane();

    await waitFor(() => expect(screen.getByRole('columnheader', { name: /Name/ })).toBeTruthy());
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getByRole('columnheader', { name: /Size/ })).toHaveAttribute('aria-sort', 'none');
  });
});
