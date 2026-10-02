// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useState } from 'react';
import { randomUUID } from 'node:crypto';
import { AgentPanel, AgentItem } from '../apps/web/src/AgentPanel';
import { AgentSettings } from '../apps/web/src/AgentSettings';
import { ActivityBar } from '../apps/web/src/workspace/ActivityBar';
import { UiProvider } from '../apps/web/src/ui';
import { api, post, put } from '../apps/web/src/api';
import { flushOpenDocuments } from '../apps/web/src/documentSaves';
import { FakeSocket } from './web-support';
import type { AgentSnapshot } from '@repellet/shared';
vi.mock('../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  wsUrl: (value: string) => value,
  errorMessage: (error: Error) => error.message,
}));
vi.mock('../apps/web/src/documentSaves', () => ({ flushOpenDocuments: vi.fn() }));
const generation = randomUUID();
let snapshot: AgentSnapshot;
const thread = {
  id: 'thread',
  name: 'My conversation',
  preview: '',
  parentThreadId: null,
  turns: [],
};
const settings = { mode: 'chatgpt', model: '', baseUrl: '', effort: null, hasApiKey: false };
const rpcCalls: any[] = [];
beforeEach(() => {
  snapshot = {
    generation,
    sequence: 0,
    connected: true,
    active: null,
    waiting: false,
    pending: [],
    items: [],
    error: null,
  };
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  rpcCalls.length = 0;
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) =>
      path.endsWith('/status')
        ? snapshot
        : path === '/agent/settings'
          ? settings
          : { account: null, login: null },
    );
  vi.mocked(post)
    .mockReset()
    .mockImplementation(async (path, body: any) => {
      if (path.endsWith('/rpc')) {
        rpcCalls.push(body);
        return body.method === 'thread/list'
          ? { data: [thread] }
          : body.method === 'thread/read' || body.method === 'thread/start'
            ? { thread }
            : body.method === 'model/list'
              ? {
                  data: [
                    {
                      id: 'model',
                      model: 'model',
                      displayName: 'Codex model',
                      defaultReasoningEffort: 'medium',
                      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
                      isDefault: true,
                    },
                  ],
                }
              : {};
      }
      return {};
    });
  vi.mocked(put)
    .mockReset()
    .mockResolvedValue({ ...settings, hasApiKey: true });
  vi.mocked(flushOpenDocuments).mockReset().mockResolvedValue();
});
function Panel() {
  const [threadId, setThreadId] = useState('thread');
  return (
    <AgentPanel
      projectId="project"
      selectedThread={threadId}
      onSelectThread={setThreadId}
      onOpenFile={vi.fn()}
    />
  );
}
async function mountPanel() {
  render(
    <UiProvider>
      <Panel />
    </UiProvider>,
  );
  await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
  await act(async () => FakeSocket.instances[0]!.message({ type: 'snapshot', snapshot }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Send', exact: true }) as HTMLButtonElement).disabled,
    ).toBe(true),
  );
  await screen.findByRole('option', { name: 'My conversation' });
}
it('hides Agent controls from editors and viewers and exposes them only with strict ownership', () => {
  const props = {
    pane: 'files',
    showSidebar: true,
    showTerminal: false,
    showPreview: true,
    onPane: vi.fn(),
    onTogglePreview: vi.fn(),
    onToggleTerminal: vi.fn(),
  };
  const view = render(<ActivityBar {...props} agentOwner={false} />);
  expect(screen.queryByRole('button', { name: 'Agent', exact: true })).toBeNull();
  view.rerender(<ActivityBar {...props} agentOwner />);
  expect(screen.getByRole('button', { name: 'Agent', exact: true })).not.toBeNull();
});
it('retains each turn and reconciles synthetic history IDs with live message IDs', async () => {
  const original = vi.mocked(post).getMockImplementation()!;
  vi.mocked(post).mockImplementation(async (path, body: any) => {
    if (body?.method === 'thread/read')
      return {
        thread: {
          ...thread,
          turns: [
            {
              id: 'older',
              items: [{ type: 'agentMessage', id: 'item-1', text: 'Earlier answer' }],
            },
            { id: 'newer', items: [{ type: 'agentMessage', id: 'item-1', text: 'Latest answer' }] },
          ],
        },
      };
    return original(path, body);
  });
  snapshot.items = [
    {
      threadId: 'thread',
      turnId: 'newer',
      item: {
        type: 'agentMessage',
        id: 'live-message-id',
        text: 'Latest answer',
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    },
  ];
  await mountPanel();
  await screen.findByText('Earlier answer');
  await waitFor(() => expect(screen.getAllByText('Latest answer')).toHaveLength(1));
});
it('flushes browser saves before sending and steers an active turn instead of starting another', async () => {
  await mountPanel();
  fireEvent.change(screen.getByLabelText('Message Codex'), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
  await waitFor(() => expect(rpcCalls.some((call) => call.method === 'turn/start')).toBe(true));
  expect(flushOpenDocuments).toHaveBeenCalledWith('project');
  await act(async () =>
    FakeSocket.instances[0]!.message({
      type: 'snapshot',
      snapshot: { ...snapshot, active: { threadId: 'thread', turnId: 'turn' } },
    }),
  );
  fireEvent.change(screen.getByLabelText('Message Codex'), { target: { value: 'Follow-up' } });
  fireEvent.click(screen.getByRole('button', { name: 'Steer', exact: true }));
  await waitFor(() =>
    expect(
      rpcCalls.some(
        (call) => call.method === 'turn/steer' && call.params.expectedTurnId === 'turn',
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Stop', exact: true }));
  await waitFor(() =>
    expect(
      rpcCalls.some((call) => call.method === 'turn/interrupt' && call.params.turnId === 'turn'),
    ).toBe(true),
  );
});
it('streams Markdown and command output, restores pending questions, and responds inline', async () => {
  snapshot.pending = [
    {
      id: 1,
      params: {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'question',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'choice',
            header: 'Choose',
            question: 'Which option?',
            isOther: true,
            isSecret: false,
            options: [{ label: 'First', description: 'Choice one' }],
          },
        ],
      },
    },
  ];
  snapshot.waiting = true;
  snapshot.items = [
    {
      threadId: 'thread',
      turnId: 'turn',
      item: {
        type: 'agentMessage',
        id: 'message',
        text: '**Streaming** response',
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    },
  ];
  await mountPanel();
  expect(screen.getByText('Streaming').tagName).toBe('STRONG');
  fireEvent.change(screen.getByLabelText('Which option?'), { target: { value: 'First' } });
  fireEvent.click(screen.getByRole('button', { name: 'Answer', exact: true }));
  await waitFor(() =>
    expect(
      rpcCalls.some((call) => call.method === 'question/respond' && call.params.requestId === 1),
    ).toBe(true),
  );
});
it('reconciles a lost response without automatically replaying the user prompt', async () => {
  await mountPanel();
  const original = vi.mocked(post).getMockImplementation()!;
  vi.mocked(post).mockImplementation(async (path, body: any) => {
    if (body?.method === 'turn/start')
      throw new Error('Codex response was lost. Refresh status and history.');
    return original(path, body);
  });
  fireEvent.change(screen.getByLabelText('Message Codex'), {
    target: { value: 'Please change the file' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
  await screen.findByText(/Codex response was lost/);
  expect(
    vi.mocked(post).mock.calls.filter(([, body]: any) => body?.method === 'turn/start'),
  ).toHaveLength(1);
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path.endsWith('/status')).length,
  ).toBeGreaterThan(1);
});
it('renders file diffs linked to the editor and strips unsafe Markdown HTML', () => {
  const openFile = vi.fn();
  const view = render(
    <AgentItem
      item={{
        type: 'fileChange',
        id: 'diff',
        status: 'completed',
        changes: [
          {
            path: '/workspace/src/app.ts',
            kind: { type: 'update', move_path: null },
            diff: '+const x = 1',
          },
        ],
      }}
      onOpenFile={openFile}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'src/app.ts' }));
  expect(openFile).toHaveBeenCalledWith('src/app.ts');
  view.rerender(
    <AgentItem
      item={{
        type: 'agentMessage',
        id: 'message',
        text: '<script>alert(1)</script> [bad](javascript:alert(1))',
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      }}
      onOpenFile={openFile}
    />,
  );
  expect(view.container.querySelector('script')).toBeNull();
  expect(view.container.querySelector('a')?.getAttribute('href') || '').not.toMatch(/^javascript:/);
});
it('retains stored provider keys without disclosing them in the settings form', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/agent/settings'
      ? {
          ...settings,
          mode: 'custom',
          hasApiKey: true,
          model: 'custom-model',
          baseUrl: 'http://localhost:1234/v1',
        }
      : { account: null, login: null },
  );
  render(
    <UiProvider>
      <AgentSettings onClose={vi.fn()} />
    </UiProvider>,
  );
  const input = await screen.findByLabelText('API key');
  expect((input as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }));
  await waitFor(() => expect(put).toHaveBeenCalled());
  expect(vi.mocked(put).mock.calls[0]![1]).not.toHaveProperty('apiKey');
});
it('copies the device code over HTTP and confirms success without an account error', async () => {
  vi.stubGlobal('navigator', { clipboard: undefined });
  const original = Object.getOwnPropertyDescriptor(document, 'execCommand');
  const copy = vi.fn(() => {
    expect((document.activeElement as HTMLTextAreaElement).value).toBe('TEST-CODE');
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: copy });
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/agent/settings'
      ? settings
      : {
          account: null,
          login: {
            state: 'pending',
            error: null,
            login: {
              type: 'chatgptDeviceCode',
              loginId: 'login',
              userCode: 'TEST-CODE',
              verificationUrl: 'https://auth.openai.com/codex/device',
            },
          },
        },
  );
  try {
    render(
      <UiProvider>
        <AgentSettings onClose={vi.fn()} />
      </UiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Copy code' }));
    await screen.findByText('Code copied.');
    expect(copy).toHaveBeenCalledWith('copy');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  } finally {
    if (original) Object.defineProperty(document, 'execCommand', original);
    else Reflect.deleteProperty(document, 'execCommand');
  }
});
