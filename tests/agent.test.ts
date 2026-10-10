import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  agentRpcSchema,
  agentSettingsSchema,
  projectAgentEvent,
  type AgentSnapshot,
} from '@repellet/shared';
import { AgentConnection } from '../apps/worker/src/agent/connection.js';
import { readAuthCache } from '../apps/worker/src/agent/auth-cache.js';
import type { Thread } from '@repellet/agent-protocol';
const state = vi.hoisted(() => ({ root: '', usage: 0, connections: new Map<string, any>() }));
vi.mock('../apps/worker/src/agent/resource-control.js', () => ({
  forwardResourceControl: vi.fn(),
}));
vi.mock('../apps/worker/src/databases.js', () => ({ databaseBytes: async () => 0 }));
vi.mock('../apps/worker/src/agent/process.js', async () => {
  const { AgentConnection } = await import('../apps/worker/src/agent/connection.js');
  return {
    startProjectProcess: async (id: string) => {
      const home = path.join(state.root, id);
      await mkdir(home, { recursive: true });
      const child = spawn(process.execPath, [path.resolve('tests/fake-app-server.mjs')], {
        env: { ...process.env, AGENT_ACCOUNT_HOME: home },
      });
      const connection = new AgentConnection({
        input: child.stdin,
        output: child.stdout,
        errors: child.stderr,
        close: () => {
          child.kill();
        },
      });
      state.connections.set(id, connection);
      return connection;
    },
    killProjectAgent: vi.fn(),
    projectAgentBytes: async () => 100,
  };
});
vi.mock('../apps/worker/src/workspaces.js', () => ({
  bridgeRequest: async (_id: string, route: string) =>
    new Response(
      JSON.stringify(
        route === '/usage' ? { bytes: state.usage, exceeded: state.usage > 1000 } : {},
      ),
      { headers: { 'content-type': 'application/json' } },
    ),
  locked: async (_id: string, fn: () => unknown) => fn(),
}));
let accounts: typeof import('../apps/worker/src/agent/accounts.js');
let projects: typeof import('../apps/worker/src/agent/projects.js');
const userId = randomUUID(),
  one = randomUUID(),
  two = randomUUID();
let generation = '',
  threadId = '';
async function rpc(projectId: string, method: string, params: unknown = {}, gen?: string) {
  return projects.agentRpc(projectId, userId, {
    generation: gen || (await projects.agentStatus(projectId, userId)).generation,
    method,
    params,
  });
}
describe('Agent account and project supervision with a fake host', () => {
  beforeAll(async () => {
    state.root = await mkdtemp(path.join(os.tmpdir(), 'repellet-agent-test-'));
    process.env.AGENT_ACCOUNTS_HOME = path.join(state.root, 'accounts');
    process.env.AGENT_ACCOUNT_BINARY = path.resolve('tests/fake-app-server.mjs');
    accounts = await import('../apps/worker/src/agent/accounts.js');
    projects = await import('../apps/worker/src/agent/projects.js');
  });
  afterAll(async () => {
    await projects.closeAllAgents();
    await accounts.closeAccounts();
    await rm(state.root, { recursive: true, force: true });
  });
  it('completes device login, persists credentials privately, and coalesces refresh', async () => {
    const login = await accounts.startLogin(userId);
    expect(login).toMatchObject({ type: 'chatgptDeviceCode', userCode: 'TEST-CODE' });
    await vi.waitFor(async () =>
      expect((await accounts.readAccount(userId)).login?.state).toBe('completed'),
    );
    const [first, second] = await Promise.all([
      accounts.accessTokens(userId),
      accounts.accessTokens(userId),
    ]);
    expect(first).toEqual(second);
    expect(first).not.toHaveProperty('refreshToken');
    expect(await readFile(path.join(accounts.accountHome(userId), 'refresh-count'), 'utf8')).toBe(
      '1',
    );
    expect((await stat(accounts.accountHome(userId))).mode & 0o777).toBe(0o700);
    await accounts.closeAccounts();
    expect((await accounts.readAccount(userId)).account?.type).toBe('chatgpt');
    const methods = await readFile(path.join(accounts.accountHome(userId), 'methods'), 'utf8');
    expect(methods).not.toMatch(/thread\/|turn\//);
  });
  it('cancels replacement login without accepting completion', async () => {
    const login = await accounts.startLogin(userId);
    if ('loginId' in login && login.loginId) await accounts.cancelLogin(userId, login.loginId);
    expect((await accounts.readAccount(userId)).login?.state).toBe('cancelled');
    await expect(accounts.cancelLogin(userId, randomUUID())).rejects.toThrow('no longer pending');
  });
  it('keeps plaintext keys private and supports retain, replace, remove, and switching', async () => {
    const saved = await accounts.saveSettings(userId, {
      mode: 'custom',
      baseUrl: 'http://192.168.1.5:8080/custom/v1',
      model: 'local-model',
      apiKey: 'test-secret',
    });
    expect(saved.hasApiKey).toBe(true);
    expect(saved).not.toHaveProperty('apiKey');
    expect(
      await readFile(path.join(accounts.accountHome(userId), 'repellet-settings.json'), 'utf8'),
    ).toContain('test-secret');
    await accounts.saveSettings(userId, {
      mode: 'chatgpt',
      baseUrl: saved.baseUrl,
      model: saved.model,
    });
    expect((await accounts.privateSettings(userId)).apiKey).toBe('test-secret');
    await accounts.saveSettings(userId, {
      mode: 'custom',
      baseUrl: saved.baseUrl,
      model: saved.model,
      apiKey: 'replacement',
    });
    expect((await accounts.privateSettings(userId)).apiKey).toBe('replacement');
    await accounts.saveSettings(userId, {
      mode: 'chatgpt',
      baseUrl: saved.baseUrl,
      model: saved.model,
      apiKey: null,
    });
    expect((await accounts.privateSettings(userId)).apiKey).toBeNull();
  });
  it('reports expired device login and allows reconnecting', async () => {
    const marker = path.join(accounts.accountHome(userId), 'login-fails');
    await writeFile(marker, 'expired');
    await accounts.startLogin(userId);
    await vi.waitFor(async () =>
      expect((await accounts.readAccount(userId)).login?.state).toBe('error'),
    );
    expect((await accounts.readAccount(userId)).login?.error).toContain('expired');
    await rm(marker);
    await accounts.startLogin(userId);
    await vi.waitFor(async () =>
      expect((await accounts.readAccount(userId)).login?.state).toBe('completed'),
    );
  });
  it('isolates project histories and rejects arbitrary method/parameter injection', async () => {
    const status = await projects.agentStatus(one, userId);
    generation = status.generation;
    threadId = (await rpc(one, 'thread/start')).thread.id;
    await expect(rpc(two, 'thread/read', { threadId })).rejects.toThrow('not found');
    for (const [method, params] of [
      ['command/exec', { command: 'id' }],
      ['account/login/start', {}],
      ['thread/start', { cwd: '/other' }],
      ['thread/resume', { threadId, history: [] }],
      ['turn/start', { threadId, input: [{ type: 'text', text: 'hello' }], config: {} }],
    ])
      expect(() => agentRpcSchema.parse({ generation, method, params })).toThrow();
  });
  it('streams responses and restores unresolved questions in atomic snapshots', async () => {
    await rpc(one, 'turn/start', { threadId, input: [{ type: 'text', text: 'question' }] });
    await vi.waitFor(async () =>
      expect((await projects.agentStatus(one, userId)).pending).toHaveLength(1),
    );
    const client = new EventEmitter() as any;
    client.readyState = 1;
    client.send = vi.fn();
    await projects.attachAgent(client, one, userId);
    const snapshot = JSON.parse(client.send.mock.calls[0][0]).snapshot as AgentSnapshot;
    expect(snapshot.waiting).toBe(true);
    expect(
      snapshot.items.some(
        (entry) => entry.item.type === 'agentMessage' && entry.item.text === 'Hello from Codex',
      ),
    ).toBe(true);
    expect(projects.agentActivity(one).executing).toBe(false);
    expect(() => projects.assertAccountIdle(userId)).toThrow('Stop active');
    client.emit('close');
    expect(projects.agentActivity(one).active).toBe(true);
    await expect(
      rpc(one, 'question/respond', { requestId: 702, answers: { choice: { answers: ['A'] } } }),
    ).rejects.toThrow('no longer pending');
    await rpc(one, 'question/respond', { requestId: 701, answers: { choice: { answers: ['A'] } } });
    await vi.waitFor(() => expect(projects.agentActivity(one).active).toBe(false));
  });
  it('reads a new thread before its first message and keeps genuine history errors visible', async () => {
    const empty = (await rpc(one, 'thread/start')).thread;
    const connection = state.connections.get(one) as AgentConnection;
    const call = vi.spyOn(connection, 'call');
    try {
      const result = await rpc(one, 'thread/read', { threadId: empty.id, includeTurns: true });
      expect(result.thread.id).toBe(empty.id);
      expect(result.thread.turns).toEqual([]);
      expect(call).toHaveBeenCalledWith('thread/read', {
        threadId: empty.id,
        includeTurns: true,
      });
      call.mockRejectedValueOnce(new Error('History is unreadable'));
      await expect(
        rpc(one, 'thread/read', { threadId: empty.id, includeTurns: true }),
      ).rejects.toThrow('History is unreadable');
      await rpc(one, 'turn/start', {
        threadId: empty.id,
        input: [{ type: 'text', text: 'Hello' }],
      });
      await vi.waitFor(() => expect(projects.agentActivity(one).active).toBe(false));
      const saved = await rpc(one, 'thread/read', { threadId: empty.id, includeTurns: true });
      expect(saved.thread.turns).toHaveLength(1);
      expect(JSON.stringify(saved)).toContain('Hello from Codex');
    } finally {
      call.mockRestore();
    }
  });
  it('runs different projects concurrently while limiting each project to one top-level turn', async () => {
    const otherThread = (await rpc(two, 'thread/start')).thread.id;
    await Promise.all([
      rpc(one, 'turn/start', { threadId, input: [{ type: 'text', text: 'hold' }] }),
      rpc(two, 'turn/start', { threadId: otherThread, input: [{ type: 'text', text: 'hold' }] }),
    ]);
    expect(projects.agentActivity(one).executing).toBe(true);
    expect(projects.agentActivity(two).executing).toBe(true);
    await expect(
      rpc(one, 'turn/start', { threadId, input: [{ type: 'text', text: 'second' }] }),
    ).rejects.toThrow('already has an active');
    const active = (await projects.agentStatus(one, userId)).active!;
    await rpc(one, 'turn/steer', {
      threadId,
      expectedTurnId: active.turnId,
      input: [{ type: 'text', text: 'guidance' }],
    });
    await rpc(one, 'turn/interrupt', active);
    await projects.closeUserAgents(userId);
    const next = await projects.agentStatus(one, userId);
    expect(next.generation).not.toBe(generation);
    expect(next.active).toBeNull();
    expect(
      (await rpc(one, 'thread/read', { threadId, includeTurns: true })).thread.turns,
    ).toHaveLength(2);
    await expect(rpc(one, 'thread/start', {}, generation)).rejects.toThrow('process changed');
  });
  it('fails unsupported server requests explicitly and recovers history without replay', async () => {
    await rpc(one, 'turn/start', { threadId, input: [{ type: 'text', text: 'unsupported' }] });
    await vi.waitFor(() => expect(state.connections.get(one).closed).toBe(true));
    expect((await projects.agentStatus(one, userId)).active).toBeNull();
    expect(
      (await rpc(one, 'thread/read', { threadId, includeTurns: true })).thread.turns.length,
    ).toBeGreaterThan(1);
  });
  it('rejects exhausted storage and clears central authentication on explicit logout', async () => {
    state.usage = 2000;
    await expect(
      rpc(one, 'turn/start', { threadId, input: [{ type: 'text', text: 'no room' }] }),
    ).rejects.toThrow('storage limit');
    state.usage = 0;
    await Promise.all([accounts.accessTokens(userId), accounts.logout(userId)]);
    expect((await accounts.readAccount(userId)).account).toBeNull();
    await expect(readFile(path.join(accounts.accountHome(userId), 'auth.json'))).rejects.toThrow();
  });
});
it('validates version-specific auth caches and rejects expired tokens', () => {
  for (const contents of ['{}', '{"tokens":{"access_token":"not-jwt"}}', '{broken'])
    expect(() => readAuthCache(contents)).toThrow('Reconnect');
  const token = 'test.' + Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') + '.test';
  expect(() =>
    readAuthCache(
      JSON.stringify({
        tokens: {
          access_token: token,
          refresh_token: 'refresh',
          id_token: 'identity',
          account_id: 'account',
        },
      }),
    ),
  ).toThrow('expired');
});
it('validates custom endpoints without blocking private networks or changing API paths', () => {
  for (const baseUrl of [
    'file:///tmp/api',
    'http://user:password@localhost/v1',
    'https://example.test/v1?key=secret',
  ])
    expect(() =>
      agentSettingsSchema.parse({ mode: 'custom', baseUrl, model: 'model', apiKey: 'key' }),
    ).toThrow();
  expect(
    agentSettingsSchema.parse({
      mode: 'custom',
      baseUrl: 'http://localhost:1234/custom/v1',
      model: 'model',
      apiKey: 'key',
    }).baseUrl,
  ).toBe('http://localhost:1234/custom/v1');
});
it('does not retry a lost mutation and rejects all inflight requests on process failure', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const close = vi.fn();
  const connection = new AgentConnection({ input, output, close });
  const messages: string[] = [];
  input.on('data', (chunk) => messages.push(chunk.toString()));
  const pending = connection.call('thread/start');
  const rejection = expect(pending).rejects.toThrow('exited');
  output.end();
  await rejection;
  expect(messages).toHaveLength(1);
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  await connection.close();
  expect(close).toHaveBeenCalledOnce();
});
it('ignores stale generations and sequence numbers in reconnect projections', () => {
  const snapshot: AgentSnapshot = {
    generation: randomUUID(),
    sequence: 10,
    connected: true,
    active: null,
    pending: [],
    waiting: false,
    items: [],
    error: null,
  };
  expect(
    projectAgentEvent(snapshot, {
      type: 'process/error',
      generation: randomUUID(),
      sequence: 11,
      message: 'old process',
    }),
  ).toBe(snapshot);
  expect(
    projectAgentEvent(snapshot, {
      type: 'process/error',
      generation: snapshot.generation,
      sequence: 9,
      message: 'old sequence',
    }),
  ).toBe(snapshot);
});
