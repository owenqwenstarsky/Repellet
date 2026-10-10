import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentStoredSettings } from '@repellet/shared';
const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as any[],
  preferences: null as AgentStoredSettings | null,
  signedIn: true,
  models: ['a', 'b'],
  requests: [] as any[],
  connections: [] as any[],
}));
vi.mock('node:fs', () => ({
  promises: {
    readFile: async (file: string) => {
      if (!state.files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return state.files.get(file);
    },
    mkdir: vi.fn(async () => {}),
    writeFile: async (file: string, data: string, options: any) => {
      state.writes.push(options);
      state.files.set(file, data);
    },
    rename: async (from: string, to: string) => {
      state.files.set(to, state.files.get(from)!);
      state.files.delete(from);
    },
    rm: async (file: string) => {
      state.files.delete(file);
    },
  },
}));
vi.mock('../apps/worker/src/agent/accounts.js', () => ({
  accountsRoot: '/accounts',
  storedSettings: async () => structuredClone(state.preferences),
  readAccount: async () => ({ account: state.signedIn ? { type: 'chatgpt' } : null }),
  withAccount: async (_id: string, operation: any) => operation(),
  accessTokens: async () => {
    if (!state.signedIn) throw new Error('Sign in with ChatGPT');
    return { accessToken: 'private-chatgpt', chatgptAccountId: 'account' };
  },
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: async () => ({
      getModels: () => ['gpt-6.1-sol', 'same'].map((id) => ({ id, name: id, reasoning: true })),
    }),
  },
}));
vi.mock('@earendil-works/pi-ai/compat', () => ({
  getSupportedThinkingLevels: () => ['off', 'medium', 'high'],
}));
vi.mock('../apps/worker/src/config.js', () => ({ config: {}, projectId: (id: string) => id }));
vi.mock('../apps/worker/src/workspaces.js', () => ({
  locked: async (_id: string, operation: any) => operation(),
  bridgeRequest: async () => new Response(JSON.stringify({ bytes: 0, exceeded: false })),
}));
vi.mock('../apps/worker/src/agent/project-control.js', () => ({ forwardProjectControl: vi.fn() }));
vi.mock('../apps/worker/src/agent/process.js', () => ({
  killProjectAgent: vi.fn(async () => {}),
  projectAgentBytes: async () => 0,
  startProjectProcess: async (_project: string, settings: any) => {
    const connection: any = new EventEmitter();
    connection.settings = settings;
    connection.closed = false;
    connection.calls = [];
    connection.initialize = async () => {};
    connection.addSecrets = vi.fn();
    connection.close = vi.fn(async () => {
      connection.closed = true;
    });
    connection.threads = new Map();
    connection.call = async (method: string, params: any) => {
      connection.calls.push({ method, params });
      if (method === 'thread/start') {
        const thread = {
          id: 'thread',
          cwd: '/workspace',
          parentThreadId: null,
          model: params.model,
          modelProvider: params.api === 'cliproxyapi' ? 'repellet' : 'openai-codex',
          turns: [],
        };
        connection.threads.set(thread.id, thread);
        return { thread };
      }
      if (method === 'thread/read') return { thread: connection.threads.get(params.threadId) };
      if (method === 'turn/start') {
        const turn = { id: randomUUID(), status: 'inProgress', items: [] };
        connection.active = { threadId: params.threadId, turn };
        connection.emit('notification', {
          method: 'turn/started',
          params: { threadId: params.threadId, turn },
        });
        return { turn };
      }
      if (method === 'thread/compact/start')
        return { thread: connection.threads.get(params.threadId) };
      return { ok: true };
    };
    connection.complete = () => {
      connection.emit('notification', {
        method: 'turn/completed',
        params: {
          threadId: connection.active.threadId,
          turn: { ...connection.active.turn, status: 'completed' },
        },
      });
    };
    state.connections.push(connection);
    return connection;
  },
}));
import * as providers from '../apps/worker/src/agent/providers.js';
import * as projects from '../apps/worker/src/agent/projects.js';
const user = 'user',
  project = 'project';
const prefs = (): AgentStoredSettings => ({
  version: 2,
  defaultApi: 'chatgpt',
  defaults: { chatgpt: { model: '', effort: null }, cliproxyapi: { model: 'a', effort: null } },
  personalProxy: { baseUrl: 'https://personal.invalid/v1', apiKey: 'personal-secret' },
});
beforeEach(() => {
  state.files.clear();
  state.writes.length = 0;
  state.connections.length = 0;
  state.preferences = prefs();
  state.signedIn = true;
  state.models = ['a', 'b'];
  state.requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: any) => {
      state.requests.push({ url, options });
      return new Response(JSON.stringify({ data: state.models.map((id) => ({ id })) }));
    }),
  );
});
afterEach(async () => {
  await projects.closeAllAgents();
  vi.unstubAllGlobals();
});
async function global(allowedModels = ['a']) {
  return providers.withProviderPolicy(() =>
    providers.saveGlobalSettings({
      enabled: true,
      baseUrl: 'https://global.invalid/prefix/v1/',
      apiKey: 'global-secret',
      allowedModels,
    }),
  );
}
async function rpc(method: string, params: any = {}) {
  const status = await projects.agentStatus(project, user);
  return projects.agentRpc(project, user, { generation: status.generation, method, params });
}
it('previews sorted unique IDs without saving and preserves URL prefixes and private keys', async () => {
  state.models = [' b ', 'a', 'b'];
  const result = await providers.previewGlobalModels({
    baseUrl: 'https://global.invalid/prefix/v1/',
    apiKey: 'private-key',
  });
  expect(result.models).toEqual(['a', 'b']);
  expect(state.files.size).toBe(0);
  expect(state.requests[0]).toMatchObject({
    url: 'https://global.invalid/prefix/v1/models',
    options: {
      redirect: 'error',
      headers: { authorization: 'Bearer private-key' },
    },
  });
  expect(JSON.stringify(result)).not.toContain('private-key');
});
it('retains and removes the saved key, requires discovery on changed connections, and treats an empty allowlist as deny-all', async () => {
  await global();
  await providers.saveGlobalSettings({
    enabled: true,
    baseUrl: 'https://global.invalid/prefix/v1/',
    allowedModels: [],
  });
  expect((await providers.globalSettings()).apiKey).toBe('global-secret');
  expect((await providers.modelCatalog(user, 'cliproxyapi')).data).toEqual([]);
  await expect(
    providers.saveGlobalSettings({ enabled: true, baseUrl: '', apiKey: null, allowedModels: [] }),
  ).rejects.toThrow('Disable');
  await providers.saveGlobalSettings({
    enabled: false,
    baseUrl: '',
    apiKey: null,
    allowedModels: [],
  });
  expect((await providers.globalSettings()).apiKey).toBeNull();
  expect(state.writes.every((options) => options.mode === 0o600 && options.flag === 'wx')).toBe(
    true,
  );
});
it('filters discovered models, preserves missing allowed IDs, and never allows newly discovered IDs automatically', async () => {
  await global();
  state.models = ['b', 'new'];
  const refreshed = await providers.modelCatalog(user, 'cliproxyapi', true);
  expect(refreshed.data).toEqual([]);
  expect((await providers.publicGlobalSettings()).allowedModels).toEqual(['a']);
  expect((await providers.publicGlobalSettings()).models).toEqual(['b', 'new']);
  await providers.saveGlobalSettings({
    enabled: true,
    baseUrl: 'https://global.invalid/prefix/v1/',
    allowedModels: ['a', 'new'],
  });
  expect(
    (await providers.modelCatalog(user, 'cliproxyapi')).data.map((model) => model.model),
  ).toEqual(['new']);
  await expect(
    providers.saveGlobalSettings({
      enabled: true,
      baseUrl: 'https://global.invalid/prefix/v1/',
      allowedModels: ['invented'],
    }),
  ).rejects.toThrow('Load models');
});
it('keeps the last successful catalog on refresh failure and invalidates it for a changed connection', async () => {
  await global();
  vi.mocked(fetch).mockRejectedValue(new Error('secret upstream response'));
  const result = await providers.modelCatalog(user, 'cliproxyapi', true);
  expect(result.data.map((model) => model.model)).toEqual(['a']);
  expect(result.error).toContain('Could not load');
  expect(JSON.stringify(result)).not.toContain('secret upstream');
  await expect(
    providers.saveGlobalSettings({
      enabled: true,
      baseUrl: 'https://other.invalid/v1',
      allowedModels: ['a'],
    }),
  ).rejects.toThrow('Could not load');
  expect((await providers.globalSettings()).baseUrl).toContain('global.invalid');
});
it('rejects malformed catalogs and upstream errors without exposing their bodies', async () => {
  for (const body of [{ data: [{ id: 1 }] }, { data: [{ id: '' }] }, { notData: [] }]) {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(
      providers.discoverModels({ baseUrl: 'https://test.invalid/v1', apiKey: 'secret' }),
    ).rejects.toThrow('Invalid model');
  }
  vi.mocked(fetch).mockResolvedValue(new Response('secret body', { status: 401 }));
  await expect(
    providers.discoverModels({ baseUrl: 'https://test.invalid/v1', apiKey: 'secret' }),
  ).rejects.toThrow('HTTP 401');
});
it('hides global connection details, keeps ChatGPT independent, and restores personal settings when disabled', async () => {
  await global();
  state.signedIn = false;
  const settings = await providers.userSettings(user);
  expect(settings.personalProxy).toBeUndefined();
  expect(settings.proxySource).toBe('global');
  expect(settings.availability).toMatchObject({
    chatgpt: { available: false },
    cliproxyapi: { available: true },
  });
  expect(JSON.stringify(settings)).not.toMatch(/global-secret|global.invalid|personal-secret/);
  await expect(
    providers.previewPersonalModels(user, { baseUrl: 'https://bypass.invalid', apiKey: 'key' }),
  ).rejects.toThrow('administrator');
  await providers.saveGlobalSettings({
    enabled: false,
    baseUrl: 'https://global.invalid/prefix/v1/',
    allowedModels: ['a'],
  });
  expect((await providers.userSettings(user)).personalProxy).toEqual({
    baseUrl: 'https://personal.invalid/v1',
    hasApiKey: true,
  });
});
it('uses draft personal credentials for discovery without changing preferences', async () => {
  const result = await providers.previewPersonalModels(user, {
    baseUrl: 'https://draft.invalid/v1',
    apiKey: 'draft-key',
  });
  expect(result.data.map((model) => model.model)).toEqual(['a', 'b']);
  expect(state.preferences?.personalProxy.apiKey).toBe('personal-secret');
});
it('applies the cache TTL and configured defaults without falling back from invalid model IDs', async () => {
  await global();
  const count = state.requests.length;
  await providers.modelCatalog(user, 'cliproxyapi');
  expect(state.requests.length).toBe(count);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
  await providers.modelCatalog(user, 'cliproxyapi');
  expect(state.requests.length).toBe(count + 1);
  const invalid = {
    ...prefs(),
    defaultApi: 'cliproxyapi' as const,
    defaults: { ...prefs().defaults, cliproxyapi: { model: 'removed', effort: null } },
  };
  await expect(providers.validatePreferences(user, invalid)).rejects.toThrow('unavailable');
  expect(providers.defaultModel([{ model: 'a' } as any], 'removed')).toBeUndefined();
  vi.restoreAllMocks();
});
it('admits proxy turns without ChatGPT login and rejects disallowed models and compaction bypasses', async () => {
  await global();
  state.signedIn = false;
  await rpc('thread/start', { api: 'cliproxyapi', model: 'a' });
  await expect(
    rpc('turn/start', {
      threadId: 'thread',
      api: 'cliproxyapi',
      model: 'b',
      input: [{ type: 'text', text: 'hello' }],
    }),
  ).rejects.toThrow('not allowed');
  await expect(
    rpc('thread/compact/start', { threadId: 'thread', api: 'cliproxyapi', model: 'b' }),
  ).rejects.toThrow('not allowed');
  await rpc('turn/start', {
    threadId: 'thread',
    api: 'cliproxyapi',
    model: 'a',
    input: [{ type: 'text', text: 'hello' }],
  });
  expect(state.connections[0].settings.apiKey).toBe('global-secret');
  expect(state.connections[0].calls.some((call: any) => call.method === 'turn/start')).toBe(true);
  state.connections[0].complete();
  await expect(
    rpc('turn/start', {
      threadId: 'thread',
      api: 'chatgpt',
      model: 'same',
      input: [{ type: 'text', text: 'hello' }],
    }),
  ).rejects.toThrow('Sign in');
});
it('switches overlapping model IDs between APIs in one host and checks the active turn lock', async () => {
  state.models = ['same'];
  await global(['same']);
  await rpc('thread/start', { api: 'chatgpt', model: 'same' });
  await rpc('turn/start', {
    threadId: 'thread',
    api: 'cliproxyapi',
    model: 'same',
    input: [{ type: 'text', text: 'hello' }],
  });
  expect(state.connections).toHaveLength(1);
  await expect(
    rpc('thread/compact/start', { threadId: 'thread', api: 'chatgpt', model: 'same' }),
  ).rejects.toThrow('active');
  state.connections[0].complete();
  await rpc('thread/compact/start', { threadId: 'thread', api: 'chatgpt', model: 'same' });
  expect(
    state.connections[0].calls.filter((call: any) => call.method === 'thread/compact/start')[0]
      .params.api,
  ).toBe('chatgpt');
});
it('lets active turns finish when policy changes and blocks further execution with revoked IDs', async () => {
  await global();
  await rpc('thread/start', { api: 'cliproxyapi', model: 'a' });
  await rpc('turn/start', {
    threadId: 'thread',
    api: 'cliproxyapi',
    model: 'a',
    input: [{ type: 'text', text: 'hello' }],
  });
  const connection = state.connections[0];
  await providers.withProviderPolicy(async () => {
    await providers.saveGlobalSettings({
      enabled: true,
      baseUrl: 'https://global.invalid/prefix/v1/',
      allowedModels: [],
    });
    await projects.invalidateAgentProviders();
  });
  expect(connection.close).not.toHaveBeenCalled();
  connection.complete();
  await vi.waitFor(() => expect(connection.close).toHaveBeenCalledOnce());
  expect(projects.agentActivity(project).active).toBe(false);
  await expect(
    rpc('turn/start', {
      threadId: 'thread',
      api: 'cliproxyapi',
      model: 'a',
      input: [{ type: 'text', text: 'hello' }],
    }),
  ).rejects.toThrow();
});

it('fails closed on corrupted global configuration without disclosing private content', async () => {
  for (const value of [
    '{"apiKey":"private-secret" broken',
    'null',
    'false',
    '{"enabled":"yes","apiKey":"private-secret"}',
  ]) {
    state.files.set('/accounts/global-cliproxyapi.json', value);
    await expect(providers.userSettings(user)).rejects.toThrow('configuration is unavailable');
    await expect(providers.userSettings(user)).rejects.not.toThrow('private-secret');
  }
});
it('serializes policy saves with turn admission without replaying a prompt', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  const admission = providers.withProviderPolicy(async () => {
    order.push('admitted');
    await gate;
    order.push('finished admission');
  });
  const change = providers.withProviderPolicy(async () => {
    order.push('changed policy');
  });
  await vi.waitFor(() => expect(order).toEqual(['admitted']));
  release();
  await Promise.all([admission, change]);
  expect(order).toEqual(['admitted', 'finished admission', 'changed policy']);
});

it('commits the refreshed admin draft catalog together with its allowlist, without activating the preview early', async () => {
  await global();
  state.models = ['b', 'new'];
  await providers.previewGlobalModels({ baseUrl: 'https://global.invalid/prefix/v1/' });
  expect((await providers.publicGlobalSettings()).models).toEqual(['a', 'b']);
  await providers.saveGlobalSettings({
    enabled: true,
    baseUrl: 'https://global.invalid/prefix/v1/',
    allowedModels: ['a'],
  });
  expect((await providers.publicGlobalSettings()).models).toEqual(['b', 'new']);
  expect((await providers.publicGlobalSettings()).allowedModels).toEqual(['a']);
  expect((await providers.modelCatalog(user, 'cliproxyapi')).data).toEqual([]);
});
