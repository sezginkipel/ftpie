import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../lib/i18n';
import type { DiffResult } from '../lib/types';
import { useEditorStore, type EditorTab } from '../store/editorStore';
import { mockInvoke } from '../test/setup';
import { ToastProvider, TooltipProvider } from './ui';
import {
  DIFF_ROW_LIMIT,
  SaveConflictDialog,
  decisionPlan,
  summariseDiff,
} from './SaveConflictDialog';

describe('decisionPlan', () => {
  it('names exactly what Overwrite destroys', () => {
    expect(decisionPlan('overwrite')).toEqual({
      command: 'save-force',
      discardsRemote: true,
      discardsLocal: false,
      closesDialog: true,
    });
  });

  it('names exactly what Reload destroys', () => {
    expect(decisionPlan('reload')).toEqual({
      command: 'revert',
      discardsRemote: false,
      discardsLocal: true,
      closesDialog: true,
    });
  });

  it('treats a diff as read-only and non-closing', () => {
    const plan = decisionPlan('diff');
    expect(plan.discardsRemote).toBe(false);
    expect(plan.discardsLocal).toBe(false);
    expect(plan.closesDialog).toBe(false);
  });

  it('makes Cancel destroy nothing', () => {
    expect(decisionPlan('cancel')).toEqual({
      command: 'none',
      discardsRemote: false,
      discardsLocal: false,
      closesDialog: true,
    });
  });
});

describe('summariseDiff', () => {
  it('reports an identical pair rather than an empty change list', () => {
    const diff: DiffResult = {
      lines: [{ op: 'equal', oldLine: 1, newLine: 1, text: 'same' }],
      insertions: 0,
      deletions: 0,
    };
    const summary = summariseDiff(diff);
    expect(summary.identical).toBe(true);
    expect(summary.truncated).toBe(0);
  });

  it('caps the rendered rows and says how many were dropped', () => {
    const lines = Array.from({ length: DIFF_ROW_LIMIT + 25 }, (_, index) => ({
      op: 'insert' as const,
      oldLine: null,
      newLine: index + 1,
      text: `line ${index}`,
    }));
    const summary = summariseDiff({ lines, insertions: lines.length, deletions: 0 });
    expect(summary.lines).toHaveLength(DIFF_ROW_LIMIT);
    expect(summary.truncated).toBe(25);
    expect(summary.identical).toBe(false);
  });
});

function tab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: 's1:/srv/a.txt',
    sessionId: 's1',
    remotePath: '/srv/a.txt',
    fileName: 'a.txt',
    content: 'mine\n',
    originalContent: 'base\n',
    originalHash: 'oldhash',
    isBinary: false,
    encoding: 'utf-8',
    size: 5,
    dirty: true,
    saving: false,
    saveError: null,
    ...overrides,
  };
}

function renderDialog(onClose = () => {}) {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ToastProvider>
          <SaveConflictDialog
            tabId="s1:/srv/a.txt"
            remoteHash="abcdef0123456789"
            onClose={onClose}
          />
        </ToastProvider>
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe('<SaveConflictDialog />', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [tab()], activeId: 's1:/srv/a.txt' });
  });

  it('offers all three exits and names what each one costs', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Show differences' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Overwrite the server’s version' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Discard my changes and reload' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Your edits are lost when you reload.')).toBeInTheDocument();
  });

  it('fetches the server copy and diffs it against the buffer', async () => {
    mockInvoke('editor_open_file', () => ({
      content: 'base\n',
      isBinary: false,
      hash: 'newhash',
      size: 5,
      encoding: 'utf-8',
    }));
    mockInvoke('editor_diff', (args) => {
      // The server's copy is the *original*; the dirty buffer is the modified
      // side. Getting these round the wrong way inverts every +/- sign.
      expect(args.original).toBe('base\n');
      expect(args.modified).toBe('mine\n');
      return {
        lines: [
          { op: 'delete', oldLine: 1, newLine: null, text: 'base' },
          { op: 'insert', oldLine: null, newLine: 1, text: 'mine' },
        ],
        insertions: 1,
        deletions: 1,
      } satisfies DiffResult;
    });

    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Show differences' }));
    expect(await screen.findByText('1 added, 1 removed')).toBeInTheDocument();
  });

  it('keeps the tab dirty and stays open when Overwrite fails', async () => {
    mockInvoke('editor_save_file', () => {
      throw { code: 'permission', message: 'EACCES' };
    });
    let closed = false;
    renderDialog(() => {
      closed = true;
    });

    await userEvent.click(screen.getByRole('button', { name: 'Overwrite the server’s version' }));

    expect(await screen.findByText(/does not have permission/)).toBeInTheDocument();
    expect(closed).toBe(false);
    expect(useEditorStore.getState().byId('s1:/srv/a.txt')?.dirty).toBe(true);
  });

  it('closes after a successful Overwrite', async () => {
    mockInvoke('editor_save_file', (args) => {
      // "Overwrite" means dropping the optimistic check, not sending a stale
      // hash the server would refuse again.
      expect((args.args as { expectedHash: unknown }).expectedHash).toBeNull();
      return { hash: 'newhash', bytes: 5 };
    });
    let closed = false;
    renderDialog(() => {
      closed = true;
    });

    await userEvent.click(screen.getByRole('button', { name: 'Overwrite the server’s version' }));
    expect(closed).toBe(true);
    expect(useEditorStore.getState().byId('s1:/srv/a.txt')?.dirty).toBe(false);
  });
});
