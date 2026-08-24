import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { I18nProvider, translate } from '../lib/i18n';
import type { AiAction, AiProviderInfo, AiResponse } from '../lib/types';
import { useSessionStore } from '../store/sessionStore';
import { invokeCalls, mockInvoke } from '../test/setup';
import { AiAssistant, SUPPORTED_ACTION_TYPES, actionKindLabel, actionPaths } from './AiAssistant';
import { ToastProvider, TooltipProvider } from './ui';

const t = (key: Parameters<typeof translate>[1]) => translate('en', key);

describe('SUPPORTED_ACTION_TYPES', () => {
  it('is remote-only: no script execution and no file upload', () => {
    expect([...SUPPORTED_ACTION_TYPES]).toEqual([
      'rename_file',
      'move_file',
      'delete_file',
      'create_directory',
      'change_permissions',
    ]);
    // A model-chosen local path cannot be confined to a trustworthy root, so
    // these must never appear. Uploads go through the transfer queue, where a
    // human picks the file.
    for (const forbidden of ['run_script', 'execute', 'upload_file', 'read_local_file']) {
      expect(SUPPORTED_ACTION_TYPES).not.toContain(forbidden);
    }
  });
});

describe('action rendering helpers', () => {
  it('labels every action kind', () => {
    const actions: AiAction[] = [
      { type: 'rename_file', from: '/a', to: '/b', reason: '' },
      { type: 'move_file', from: '/a', to: '/c/a', reason: '' },
      { type: 'delete_file', path: '/a', reason: '' },
      { type: 'create_directory', path: '/d', reason: '' },
      { type: 'change_permissions', path: '/a', mode: '644', reason: '' },
    ];
    expect(actions.map((action) => actionKindLabel(action, t))).toEqual([
      'Rename',
      'Move',
      'Delete',
      'New folder',
      'Permissions',
    ]);
  });

  it('lists the remote paths an action touches', () => {
    expect(actionPaths({ type: 'move_file', from: '/a', to: '/b/a', reason: '' })).toEqual([
      '/a',
      '/b/a',
    ]);
    expect(actionPaths({ type: 'delete_file', path: '/a', reason: '' })).toEqual(['/a']);
    expect(
      actionPaths({ type: 'change_permissions', path: '/a', mode: '600', reason: '' }),
    ).toEqual(['/a', '600']);
  });
});

const PROVIDERS: AiProviderInfo[] = [
  {
    provider: 'anthropic',
    hasKey: true,
    requiresKey: true,
    acceptsKey: true,
    defaultModel: 'model-a',
    needsBaseUrl: false,
  },
  {
    provider: 'openai',
    hasKey: false,
    requiresKey: true,
    acceptsKey: true,
    defaultModel: 'model-o',
    needsBaseUrl: false,
  },
  {
    provider: 'ollama',
    hasKey: false,
    requiresKey: false,
    acceptsKey: false,
    defaultModel: 'model-l',
    needsBaseUrl: false,
  },
  {
    provider: 'custom',
    hasKey: false,
    requiresKey: false,
    acceptsKey: true,
    defaultModel: 'model-c',
    needsBaseUrl: true,
  },
];

const RESPONSE: AiResponse = {
  // Deliberately hostile: if this ever renders as markup the test DOM shows it.
  message: 'Here is a plan.\n<img src=x onerror="alert(1)">',
  actions: [
    {
      action: { type: 'delete_file', path: '/srv/old.log', reason: 'stale' },
      description: 'Delete /srv/old.log',
      destructive: true,
    },
    {
      action: { type: 'create_directory', path: '/srv/logs', reason: 'tidy' },
      description: 'Create directory /srv/logs',
      destructive: false,
    },
  ],
  rejectedActions: 1,
};

function renderAssistant() {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ToastProvider>
          <AiAssistant />
        </ToastProvider>
      </TooltipProvider>
    </I18nProvider>,
  );
}

function connectSession() {
  useSessionStore.setState({
    sessions: {
      s1: { id: 's1', host: 'example.com', port: 22, username: 'me', protocol: 'sftp' },
    },
    order: ['s1'],
    activeId: 's1',
    ui: {
      s1: {
        remotePath: '/srv',
        localPath: 'C:\\tmp',
        selection: { local: [], remote: ['/srv/a.txt', '/srv/b.txt'] },
        sort: {
          local: { key: 'name', direction: 'asc' },
          remote: { key: 'name', direction: 'asc' },
        },
        secure: true,
      },
    },
    closing: [],
  });
}

describe('<AiAssistant />', () => {
  it('sends the real session context, not an empty one', async () => {
    connectSession();
    mockInvoke('ai_list_providers', () => PROVIDERS);
    mockInvoke('ai_query', () => RESPONSE);

    renderAssistant();
    await userEvent.type(screen.getByLabelText('Ask something…'), 'tidy up');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    const query = invokeCalls.find((entry) => entry.cmd === 'ai_query');
    const args = (query?.args as { args: Record<string, unknown> }).args;
    expect(args.context).toMatchObject({
      remotePath: '/srv',
      selectedFiles: ['/srv/a.txt', '/srv/b.txt'],
    });
    // No key ever crosses this boundary.
    expect(args).not.toHaveProperty('apiKey');
  });

  it('renders model output as plain text and never as markup', async () => {
    connectSession();
    mockInvoke('ai_list_providers', () => PROVIDERS);
    mockInvoke('ai_query', () => RESPONSE);

    const view = renderAssistant();
    await userEvent.type(screen.getByLabelText('Ask something…'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/<img src=x onerror="alert\(1\)">/)).toBeInTheDocument();
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('lists each action with the backend description and its own confirm button', async () => {
    connectSession();
    mockInvoke('ai_list_providers', () => PROVIDERS);
    mockInvoke('ai_query', () => RESPONSE);

    renderAssistant();
    await userEvent.type(screen.getByLabelText('Ask something…'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Delete /srv/old.log')).toBeInTheDocument();
    expect(screen.getByText('Create directory /srv/logs')).toBeInTheDocument();
    // One button per proposal — nothing is applied in bulk or implicitly.
    expect(screen.getAllByRole('button', { name: 'Do this' })).toHaveLength(2);
    expect(screen.getByText('Destructive')).toBeInTheDocument();
    expect(
      screen.getByText('1 suggestion(s) were discarded as invalid or not permitted.'),
    ).toBeInTheDocument();
  });

  it('offers no execution or upload action anywhere in the panel', async () => {
    connectSession();
    mockInvoke('ai_list_providers', () => PROVIDERS);
    mockInvoke('ai_query', () => RESPONSE);

    const view = renderAssistant();
    await userEvent.type(screen.getByLabelText('Ask something…'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Delete /srv/old.log');

    const buttonLabels = view.container.textContent ?? '';
    expect(buttonLabels).toContain('It cannot run scripts and it cannot upload files.');
    expect(screen.queryByRole('button', { name: /run|execute|upload/i })).toBeNull();
  });

  it('applies an action only when its button is clicked', async () => {
    connectSession();
    mockInvoke('ai_list_providers', () => PROVIDERS);
    mockInvoke('ai_query', () => RESPONSE);
    mockInvoke('ai_apply_action', (args) => {
      expect(args.sessionId).toBe('s1');
      expect(args.action).toMatchObject({ type: 'delete_file', path: '/srv/old.log' });
      return 'Deleted /srv/old.log';
    });

    renderAssistant();
    await userEvent.type(screen.getByLabelText('Ask something…'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Delete /srv/old.log');

    // Nothing has run yet just from rendering the proposals.
    expect(invokeCalls.some((entry) => entry.cmd === 'ai_apply_action')).toBe(false);

    await userEvent.click(screen.getAllByRole('button', { name: 'Do this' })[0]);
    expect(await screen.findByText('Deleted /srv/old.log')).toBeInTheDocument();
    expect(invokeCalls.filter((entry) => entry.cmd === 'ai_apply_action')).toHaveLength(1);
  });
});
