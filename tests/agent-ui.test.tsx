// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useState } from 'react';
import { randomUUID } from 'node:crypto';
import { AgentPanel, AgentItem } from '../apps/web/src/AgentPanel';
import { agentTranscript } from '../apps/web/src/agentTranscript';
import { groupAgentTools } from '../apps/web/src/agentTranscript';
import type { Thread, ThreadItem } from '@repellet/agent-protocol';
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
let planMode = false;
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
  planMode = false;
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
            ? { thread: { ...thread, planMode } }
            : body.method === 'thread/plan/toggle'
              ? { thread: { ...thread, planMode: (planMode = !planMode) } }
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
  await screen.findByRole('heading', { name: 'My conversation' });
}
it('toggles plan mode from the composer outside Run settings and restores its state after navigation', async () => {
  await mountPanel();
  const button = screen.getByRole('button', { name: 'Plan mode', exact: true });
  expect(button.getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('group', { name: 'Model and reasoning' })).toBeNull();
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
  expect(rpcCalls).toContainEqual(
    expect.objectContaining({ method: 'thread/plan/toggle', params: { threadId: 'thread' } }),
  );
  expect(rpcCalls.some((call) => call.method === 'turn/start')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: /Threads/ }));
  fireEvent.click(await screen.findByRole('button', { name: /^My conversation/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Plan mode', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Plan mode', exact: true }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Plan mode', exact: true }).getAttribute('aria-pressed'),
    ).toBe('false'),
  );
});
it('prevents toggling plan mode while a turn is working or waiting for input', async () => {
  await mountPanel();
  snapshot = { ...snapshot, active: { threadId: 'thread', turnId: 'turn' }, waiting: true };
  await act(async () => FakeSocket.instances[0]!.message({ type: 'snapshot', snapshot }));
  expect(
    (screen.getByRole('button', { name: 'Plan mode', exact: true }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
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
it('keeps cached live-only activity within its original turn and matches repeated message occurrences', () => {
  const message = (id: string, text: string) => ({ type: 'agentMessage', id, text }) as ThreadItem;
  const saved = {
    ...thread,
    turns: [
      {
        id: 'older',
        items: [message('saved-1', 'Checking'), message('saved-2', 'Checking')],
      },
      { id: 'newer', items: [message('saved-1', 'Latest answer')] },
    ],
  } as Thread;
  const live = [
    { threadId: 'thread', turnId: 'older', item: message('live-1', 'Checking') },
    {
      threadId: 'thread',
      turnId: 'older',
      item: { type: 'plan', id: 'plan', text: 'Intermediate plan' } as ThreadItem,
    },
    { threadId: 'thread', turnId: 'older', item: message('live-2', 'Checking') },
    { threadId: 'another-thread', turnId: 'older', item: message('foreign', 'Private') },
    { threadId: 'thread', turnId: 'newer', item: message('live-3', 'Latest answer') },
    { threadId: 'thread', turnId: 'newest', item: message('live-4', 'Still streaming') },
  ];
  const result = agentTranscript('thread', saved, live);
  expect(result.map(({ key }) => key)).toEqual([
    'older:saved-1',
    'older:plan',
    'older:saved-2',
    'newer:saved-1',
    'newest:live-4',
  ]);
  expect(result.map(({ item }) => (item as any).text)).toEqual([
    'Checking',
    'Intermediate plan',
    'Checking',
    'Latest answer',
    'Still streaming',
  ]);
  // A bounded snapshot with no common anchors still follows saved history.
  expect(agentTranscript('thread', saved, [live[1]!]).at(2)!.key).toBe('older:plan');
});

it('collapses only runs of more than three tools while preserving every tool entry', () => {
  const tool = (id: string): ThreadItem => ({
    type: 'dynamicToolCall',
    id,
    namespace: null,
    tool: 'exec',
    arguments: {},
    status: 'completed',
    contentItems: null,
    success: null,
    durationMs: null,
  });
  const message = { type: 'agentMessage', id: 'message', text: 'Between runs' } as ThreadItem;
  const entries = [
    { key: 'one', turnId: 'turn', item: tool('one') },
    { key: 'two', turnId: 'turn', item: tool('two') },
    { key: 'three', turnId: 'turn', item: tool('three') },
    { key: 'message', turnId: 'turn', item: message },
    { key: 'four', turnId: 'turn', item: tool('four') },
    { key: 'five', turnId: 'turn', item: tool('five') },
    { key: 'six', turnId: 'turn', item: tool('six') },
    { key: 'seven', turnId: 'turn', item: tool('seven') },
  ];
  const groups = groupAgentTools(entries);
  expect(groups.map((group) => group.type)).toEqual(['item', 'item', 'item', 'item', 'tools']);
  expect(groups.at(-1)).toMatchObject({ entries: entries.slice(4) });
  expect(
    groups.flatMap((group) => (group.type === 'tools' ? group.entries : [group.entry])),
  ).toEqual(entries);
});

it('preserves interleaved transcript order when switching away from a thread and reopening it', async () => {
  const original = vi.mocked(post).getMockImplementation()!;
  const saved = {
    ...thread,
    turns: [
      {
        id: 'turn',
        items: [
          { type: 'agentMessage', id: 'saved-comment', text: 'Checking files' },
          { type: 'commandExecution', id: 'command', command: 'echo checked', status: 'completed' },
          { type: 'agentMessage', id: 'saved-final', text: 'All done' },
        ],
      },
    ],
  };
  vi.mocked(post).mockImplementation(async (path, body: any) => {
    if (body?.method === 'thread/list')
      return { data: [thread, { ...thread, id: 'other', name: 'Other conversation' }] };
    if (body?.method === 'thread/read')
      return { thread: body.params.threadId === 'thread' ? saved : { ...thread, id: 'other' } };
    return original(path, body);
  });
  snapshot.items = [
    {
      threadId: 'thread',
      turnId: 'turn',
      item: { type: 'agentMessage', id: 'live-comment', text: 'Checking files' } as ThreadItem,
    },
    {
      threadId: 'thread',
      turnId: 'turn',
      item: { type: 'plan', id: 'plan', text: 'Check output' } as ThreadItem,
    },
    { threadId: 'thread', turnId: 'turn', item: saved.turns[0]!.items[1] as ThreadItem },
    {
      threadId: 'thread',
      turnId: 'turn',
      item: { type: 'agentMessage', id: 'live-final', text: 'All done' } as ThreadItem,
    },
  ];
  await mountPanel();
  const order = () => [...screen.getByRole('log').children].map((item) => item.textContent);
  await waitFor(() => expect(order()).toHaveLength(4));
  const before = order();
  expect(before[0]).toContain('Checking files');
  expect(before[1]).toContain('Check output');
  expect(before[2]).toContain('echo checked');
  expect(before[3]).toContain('All done');
  fireEvent.click(screen.getByRole('button', { name: '← Threads' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Other conversation/ }));
  await waitFor(() => expect(screen.queryByText('All done')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '← Threads' }));
  fireEvent.click(await screen.findByRole('button', { name: /My conversation.*No messages yet/ }));
  await waitFor(() => expect(order()).toEqual(before));
  expect(screen.getAllByText('All done')).toHaveLength(1);
});

it('flushes browser saves before sending and steers an active turn instead of starting another', async () => {
  await mountPanel();
  fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: 'Hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send', exact: true }));
  await waitFor(() => expect(rpcCalls.some((call) => call.method === 'turn/start')).toBe(true));
  expect(flushOpenDocuments).toHaveBeenCalledWith('project');
  await act(async () =>
    FakeSocket.instances[0]!.message({
      type: 'snapshot',
      snapshot: { ...snapshot, active: { threadId: 'thread', turnId: 'turn' } },
    }),
  );
  fireEvent.change(screen.getByLabelText('Message agent'), { target: { value: 'Follow-up' } });
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
  fireEvent.change(screen.getByLabelText('Message agent'), {
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
it('renders custom exec scripts and nested command results as readable tool activity', () => {
  const script = 'text(await tools.exec_command({cmd: "pwd"}));';
  const item: ThreadItem = {
    type: 'dynamicToolCall',
    id: 'exec',
    namespace: null,
    tool: 'exec',
    arguments: script,
    status: 'completed',
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify([
          { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
          {
            type: 'input_text',
            text: JSON.stringify({
              chunk_id: '75747e',
              exit_code: 0,
              output: '/workspace\nREADME.md\nsrc/App.tsx\n',
            }),
          },
        ]),
      },
    ],
    success: null,
    durationMs: null,
  };
  const view = render(<AgentItem item={item} onOpenFile={vi.fn()} />);
  expect(view.container.querySelector('summary')!.textContent).toBe('exec · completed');
  expect(screen.getByLabelText('Tool input').textContent).toBe(script);
  const output = screen.getByLabelText('Tool output').textContent!;
  expect(output).toContain('Script completed\nWall time 0.1 seconds\nOutput:\n');
  expect(output).toContain('/workspace\nREADME.md\nsrc/App.tsx\n');
  expect(output).toContain('Exit code 0');
  expect(output).not.toMatch(/chunk_id|input_text|dynamicToolCall|\\n/);
  // Existing saved entries that lost their script still show useful output.
  view.rerender(<AgentItem item={{ ...item, arguments: {} }} onOpenFile={vi.fn()} />);
  expect(screen.queryByLabelText('Tool input')).toBeNull();
  expect(screen.getByLabelText('Tool output').textContent).toBe(output);
});

it('keeps unfamiliar tool output intact, escapes HTML, and shows pending and failed states', () => {
  const item: ThreadItem = {
    type: 'dynamicToolCall',
    id: 'tool',
    namespace: 'custom',
    tool: 'lookup',
    arguments: { query: 'example' },
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null,
  };
  const view = render(<AgentItem item={item} onOpenFile={vi.fn()} />);
  expect(view.container.querySelector('summary')!.textContent).toBe('custom.lookup · inProgress');
  expect(screen.getByLabelText('Tool output').textContent).toBe('Waiting for output…');
  const text = '[{"type":"unknown","value":"<script>alert(1)</script>"}]';
  view.rerender(
    <AgentItem
      item={{
        ...item,
        status: 'failed',
        success: false,
        contentItems: [{ type: 'inputText', text }],
      }}
      onOpenFile={vi.fn()}
    />,
  );
  expect(screen.getByLabelText('Tool output').textContent).toBe(text);
  expect(view.container.querySelector('script')).toBeNull();
  expect(screen.getByText('Tool reported a failure.')).not.toBeNull();
  view.rerender(
    <AgentItem
      item={{
        ...item,
        status: 'completed',
        contentItems: [{ type: 'inputText', text: '{partial' }],
      }}
      onOpenFile={vi.fn()}
    />,
  );
  expect(screen.getByLabelText('Tool output').textContent).toBe('{partial');
});

it('renders GFM plans and readable structured file tools with safe file actions', () => {
  const openFile = vi.fn();
  const view = render(
    <AgentItem
      item={{
        type: 'agentMessage',
        id: 'gfm',
        text: '- [ ] pending\n\n| A | B |\n| - | - |\n| ~~old~~ | `new` |',
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      }}
      onOpenFile={openFile}
    />,
  );
  expect(view.container.querySelector('table')).not.toBeNull();
  expect(view.container.querySelector('del')?.textContent).toBe('old');
  expect(
    (view.container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled,
  ).toBe(true);
  view.rerender(
    <AgentItem
      item={{
        type: 'dynamicToolCall',
        id: 'write',
        namespace: null,
        tool: 'write',
        arguments: { path: '/workspace/src/new.ts', content: 'export const value = 1;' },
        status: 'completed',
        contentItems: null,
        success: true,
        durationMs: 4,
      }}
      onOpenFile={openFile}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'src/new.ts' }));
  expect(openFile).toHaveBeenCalledWith('src/new.ts');
  expect(screen.getByRole('button', { name: 'src/new.ts' }).getAttribute('title')).toMatch(
    /Open file/,
  );
  view.rerender(
    <AgentItem
      item={{
        type: 'dynamicToolCall',
        id: 'bad',
        namespace: null,
        tool: 'write',
        arguments: { path: '../secrets.txt', content: 'secret' },
        status: 'completed',
        contentItems: null,
        success: true,
        durationMs: null,
      }}
      onOpenFile={openFile}
    />,
  );
  expect(screen.queryByRole('button', { name: '../secrets.txt' })).toBeNull();
  expect(screen.getByText('../secrets.txt')).toBeTruthy();
  view.rerender(
    <AgentItem
      item={{
        type: 'fileChange',
        id: 'external',
        status: 'completed',
        changes: [{ path: 'https://example.com/file.ts', kind: { type: 'add' }, diff: '+remote' }],
      }}
      onOpenFile={openFile}
    />,
  );
  expect(screen.queryByRole('button', { name: /example\.com/ })).toBeNull();
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

it('shows the Threads page with search, archived filtering, row menus and empty states', async () => {
  await mountPanel();
  fireEvent.click(screen.getByRole('button', { name: '← Threads' }));
  expect(screen.queryByLabelText('Message agent')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Threads' })).not.toBeNull();
  fireEvent.change(screen.getByLabelText('Search threads'), { target: { value: 'missing' } });
  expect(screen.getByText('No threads match your search.')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Start a thread' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Search threads'), { target: { value: '' } });
  fireEvent.click(screen.getByLabelText('Archived'));
  await waitFor(() =>
    expect(rpcCalls.some((call) => call.method === 'thread/list' && call.params.archived)).toBe(
      true,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions for My conversation' }));
  expect(screen.getByRole('menuitem', { name: 'Unarchive' })).not.toBeNull();
});
it('moves focus between thread rows with arrows and opens a selected row', async () => {
  const original = vi.mocked(post).getMockImplementation()!;
  vi.mocked(post).mockImplementation(async (path, body: any) =>
    body?.method === 'thread/list'
      ? { data: [thread, { ...thread, id: 'other', name: 'Other conversation' }] }
      : original(path, body),
  );
  await mountPanel();
  fireEvent.click(screen.getByRole('button', { name: '← Threads' }));
  const first = screen.getByRole('button', { name: /^My conversation.*No messages/ });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Other conversation/ }));
  fireEvent.keyDown(document.activeElement!, { key: 'Home' });
  expect(document.activeElement).toBe(first);
  fireEvent.click(first);
  expect(screen.getByLabelText('Message agent')).not.toBeNull();
});
it('keeps model controls in Run settings and submits only with Cmd/Ctrl+Enter', async () => {
  await mountPanel();
  expect(screen.queryByLabelText('Agent model')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Run settings' }));
  expect(screen.getByLabelText('Agent model')).not.toBeNull();
  fireEvent.keyDown(screen.getByLabelText('Agent model'), { key: 'Escape' });
  expect(screen.queryByLabelText('Agent model')).toBeNull();
  const composer = screen.getByLabelText('Message agent');
  fireEvent.change(composer, { target: { value: 'Multiline\nmessage' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  expect(rpcCalls.filter((call) => call.method === 'turn/start')).toHaveLength(0);
  fireEvent.keyDown(composer, { key: 'Enter', ctrlKey: true });
  await waitFor(() =>
    expect(rpcCalls.filter((call) => call.method === 'turn/start')).toHaveLength(1),
  );
});
