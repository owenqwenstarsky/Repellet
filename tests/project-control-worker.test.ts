import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentStoredSettings } from '@repellet/shared';

const preferences = vi.hoisted((): AgentStoredSettings => ({
  version: 2,
  defaultApi: 'cliproxyapi',
  defaults: {
    chatgpt: { model: '', effort: null },
    cliproxyapi: { model: 'model', effort: null },
  },
  personalProxy: { baseUrl: 'http://test-provider', apiKey: 'private-provider-key' },
}));

vi.mock('../apps/worker/src/config.js', () => ({
  config: { appUrl: 'http://test-api', token: 'private-worker-token' },
}));
vi.mock('../apps/worker/src/agent/accounts.js', () => ({
  storedSettings: async () => structuredClone(preferences),
  withAccount: (_id: string, fn: () => unknown) => fn(),
  accessTokens: vi.fn(async () => {
    throw new Error('ChatGPT is not connected');
  }),
}));
// Keep provider discovery out of these control-transport tests: fetch belongs to
// the internal project-control API, and no private storage should be accessed.
vi.mock('../apps/worker/src/agent/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/worker/src/agent/providers.js')>()),
  runtimeSettings: async () => ({
    mode: 'custom',
    ...preferences.personalProxy,
    ...preferences.defaults.cliproxyapi,
    defaults: preferences.defaults,
    proxyModels: ['model'],
  }),
  modelCatalog: async () => ({
    data: [{ model: 'model', supportedReasoningEfforts: [] }],
  }),
}));
vi.mock('../apps/worker/src/agent/process.js', () => ({
  startProjectProcess: vi.fn(),
  killProjectAgent: vi.fn(),
  projectAgentBytes: async () => 0,
}));
vi.mock('../apps/worker/src/workspaces.js', () => ({
  bridgeRequest: async () => new Response(JSON.stringify({ bytes: 0, exceeded: false })),
  locked: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('../apps/worker/src/agent/attachments.js', () => ({ resolveAttachmentInputs: vi.fn() }));

import { forwardProjectControl } from '../apps/worker/src/agent/project-control.js';
import { startProjectProcess } from '../apps/worker/src/agent/process.js';
import { agentStatus, agentRpc, closeAllAgents } from '../apps/worker/src/agent/projects.js';
import { AgentConnection } from '../apps/worker/src/agent/connection.js';
import { PassThrough } from 'node:stream';

const context = () => ({
  projectId: 'worker-project',
  userId: 'worker-owner',
  active: () => ({ threadId: 'thread', turnId: 'turn' }),
  planMode: () => false,
});
const request = (operation = 'status') => ({
  threadId: 'thread',
  turnId: 'turn',
  operation,
  arguments: {},
});
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  await closeAllAgents();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('binds project and owner identity to the worker session and sends credentials only to the internal API', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ outcome: 'status' })));
  expect(await forwardProjectControl(context(), request(), new AbortController().signal)).toEqual({
    outcome: 'status',
  });
  const [url, options] = fetchMock.mock.calls[0]!;
  expect(url).toBe('http://test-api/internal/agent/project-control');
  expect(options.headers.authorization).toBe('Bearer private-worker-token');
  expect(JSON.parse(options.body)).toEqual({
    projectId: 'worker-project',
    userId: 'worker-owner',
    control: { operation: 'status', arguments: {} },
  });
});

it.each([
  { ...request(), projectId: 'other' },
  { ...request(), userId: 'other' },
  { ...request('start'), arguments: { command: 'other' } },
  { ...request('stop'), arguments: { processId: 'other' } },
  { ...request('logs'), arguments: { tailLines: 1.1 } },
  { ...request('logs'), arguments: { tailLines: 0 } },
  { ...request('logs'), arguments: { tailLines: 1001 } },
  request('restart'),
])('rejects extra identity and invalid tool arguments before forwarding', async (input) => {
  expect(await forwardProjectControl(context(), input, new AbortController().signal)).toMatchObject(
    { error: { code: 'invalid_request' } },
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([null, { threadId: 'other', turnId: 'turn' }, { threadId: 'thread', turnId: 'old-turn' }])(
  'rejects inactive or mismatched turns',
  async (active) => {
    expect(
      await forwardProjectControl(
        { ...context(), active: () => active },
        request('start'),
        new AbortController().signal,
      ),
    ).toMatchObject({ error: { code: 'inactive_turn' } });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it('blocks mutations in plan mode without blocking status', async () => {
  const ctx = { ...context(), planMode: () => true };
  for (const operation of ['start', 'stop'])
    expect(
      await forwardProjectControl(ctx, request(operation), new AbortController().signal),
    ).toMatchObject({ error: { code: 'plan_mode' } });
  expect(fetchMock).not.toHaveBeenCalled();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ outcome: 'status' })));
  expect(await forwardProjectControl(ctx, request(), new AbortController().signal)).toMatchObject({
    outcome: 'status',
  });
});

it('does not forward already cancelled requests', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await forwardProjectControl(context(), request('start'), controller.signal)).toMatchObject(
    { error: { code: 'cancelled' } },
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('does not replay a lost mutation and never returns raw transport errors', async () => {
  fetchMock.mockRejectedValue(new Error('private-worker-token private-provider-key'));
  const result = await forwardProjectControl(
    context(),
    request('start'),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    error: { uncertain: true, message: expect.stringContaining('project_status') },
  });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('propagates cancellation to a pending fetch and reports an uncertain mutation outcome', async () => {
  // An aborted fetch is represented in memory, without an HTTP listener.
  const controller = new AbortController();
  fetchMock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      ),
  );
  const pending = forwardProjectControl(context(), request('stop'), controller.signal);
  controller.abort();
  expect(await pending).toMatchObject({ error: { code: 'cancelled', uncertain: true } });
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([401, 403, 500])(
  'sanitizes HTTP %s bodies rather than exposing internal details',
  async (status) => {
    fetchMock.mockResolvedValue(new Response('private internal body', { status }));
    const result = await forwardProjectControl(
      context(),
      request('stop'),
      new AbortController().signal,
    );
    expect(result.outcome).toBe('error');
    expect(JSON.stringify(result)).not.toContain('private');
  },
);

async function supervisor() {
  const input = new PassThrough(),
    output = new PassThrough();
  const connection = new AgentConnection({ input, output, close: vi.fn() }, [
    'private-provider-key',
  ]);
  vi.spyOn(connection, 'initialize').mockResolvedValue();
  const projectId = randomUUID(),
    userId = randomUUID(),
    threadId = randomUUID(),
    turnId = randomUUID();
  const thread = {
    id: threadId,
    cwd: '/workspace',
    parentThreadId: null,
    modelProvider: 'repellet',
    model: 'model',
  };
  const turn = { id: turnId, status: 'inProgress', items: [], error: null };
  vi.spyOn(connection, 'call').mockImplementation(async (method) => {
    if (method === 'thread/start') return { thread };
    if (method === 'turn/start') {
      connection.emit('notification', { method: 'turn/started', params: { threadId, turn } });
      return { turn };
    }
    return {};
  });
  vi.mocked(startProjectProcess).mockResolvedValue(connection);
  const { generation } = await agentStatus(projectId, userId);
  await agentRpc(projectId, userId, { generation, method: 'thread/start', params: {} });
  await agentRpc(projectId, userId, {
    generation,
    method: 'turn/start',
    params: { threadId, input: [{ type: 'text', text: 'work' }] },
  });
  return { connection, projectId, userId, threadId, turnId, generation };
}

it('responds to project failures as tool results without closing the agent connection', async () => {
  const s = await supervisor();
  fetchMock.mockRejectedValue(new Error('private detail'));
  const respond = vi.spyOn(s.connection, 'respond');
  s.connection.emit('request', {
    id: 'control',
    method: 'repellet/project/control',
    params: { ...request('start'), threadId: s.threadId, turnId: s.turnId },
  });
  await vi.waitFor(() =>
    expect(respond).toHaveBeenCalledWith('control', expect.objectContaining({ outcome: 'error' })),
  );
  expect(s.connection.closed).toBe(false);
  const forwarded = JSON.parse(fetchMock.mock.calls[0]![1].body);
  expect(forwarded).toMatchObject({ projectId: s.projectId, userId: s.userId });
});

it.each(['resolved', 'completed', 'interrupt', 'failure'])(
  'cancels pending control fetch on %s',
  async (event) => {
    const s = await supervisor();
    let fetchSignal!: AbortSignal;
    fetchMock.mockImplementation((_url, options) => {
      fetchSignal = options.signal;
      return new Promise((_resolve, reject) =>
        fetchSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    });
    s.connection.emit('request', {
      id: 'control',
      method: 'repellet/project/control',
      params: { ...request('start'), threadId: s.threadId, turnId: s.turnId },
    });
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());
    if (event === 'resolved')
      s.connection.emit('notification', {
        method: 'serverRequest/resolved',
        params: { requestId: 'control' },
      });
    if (event === 'completed')
      s.connection.emit('notification', {
        method: 'turn/completed',
        params: { threadId: s.threadId, turn: { id: s.turnId, status: 'completed', items: [] } },
      });
    if (event === 'failure') await s.connection.close();
    if (event === 'interrupt')
      await agentRpc(s.projectId, s.userId, {
        generation: s.generation,
        method: 'turn/interrupt',
        params: { threadId: s.threadId, turnId: s.turnId },
      });
    expect(fetchSignal.aborted).toBe(true);
  },
);

it('ignores stale completion notifications when cancelling the current turn’s controls', async () => {
  const s = await supervisor();
  let fetchSignal!: AbortSignal;
  fetchMock.mockImplementation((_url, options) => {
    fetchSignal = options.signal;
    return new Promise((_resolve, reject) =>
      fetchSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  });
  s.connection.emit('request', {
    id: 'control',
    method: 'repellet/project/control',
    params: { ...request('start'), threadId: s.threadId, turnId: s.turnId },
  });
  await vi.waitFor(() => expect(fetchSignal).toBeDefined());
  s.connection.emit('notification', {
    method: 'turn/completed',
    params: { threadId: 'other-thread', turn: { id: 'old-turn', status: 'completed', items: [] } },
  });
  expect(fetchSignal.aborted).toBe(false);
  s.connection.emit('notification', {
    method: 'serverRequest/resolved',
    params: { requestId: 'control' },
  });
});
