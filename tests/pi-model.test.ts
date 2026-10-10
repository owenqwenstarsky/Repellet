import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';

const h = createRequire(import.meta.url)('../docker/pi-session.cjs');
const catalog = [
  'gpt-5.3-codex-spark',
  'gpt-5.6-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6.1-sol',
].map((id) => ({ id, name: id, provider: 'openai-codex', reasoning: true }));

it('selects the newest Sol regardless of catalog order or other model families', () => {
  expect(h.defaultModel(catalog).id).toBe('gpt-6.1-sol');
  expect(h.defaultModel([...catalog].reverse()).id).toBe('gpt-6.1-sol');
  expect(h.defaultModel([...catalog, { id: 'gpt-7-astra' }]).id).toBe('gpt-6.1-sol');
});

it('automatically selects future Sol releases using numeric version components', () => {
  const future = [...catalog, { id: 'gpt-6.10-sol' }, { id: 'gpt-6.2-sol' }];
  expect(h.defaultModel(future).id).toBe('gpt-6.10-sol');
  expect(h.defaultModel([...future, { id: 'gpt-7-sol' }]).id).toBe('gpt-7-sol');
});

it('retains the configured custom model and falls back when Sol is unavailable', () => {
  expect(h.defaultModel(catalog, 'gpt-6-astra').id).toBe('gpt-6-astra');
  expect(h.defaultModel([catalog[0]]).id).toBe('gpt-5.3-codex-spark');
  expect(h.defaultModel([])).toBeUndefined();
});

// Execute the host's RPC handlers with an in-memory filesystem, SDK and catalog.
// No host process, provider request, credentials or external service is used.
function host(models = [...catalog], configuredModel = '') {
  const index: { sessions: any[] } = { sessions: [] };
  const manager = {
    getSessionId: () => 'thread',
    getSessionName: () => null,
    getSessionFile: () => '/sessions/thread.jsonl',
    getHeader: () => ({ cwd: '/workspace' }),
    getBranch: () => [],
    appendMessage: vi.fn(),
    appendCustomEntry: vi.fn(),
  };
  const session = {
    model: models[0],
    sessionManager: manager,
    setModel: vi.fn(async (model) => {
      session.model = model;
    }),
    setThinkingLevel: vi.fn(),
    subscribe: vi.fn(),
    bindExtensions: vi.fn(),
    prompt: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
  };
  const runtime = {
    getAvailable: async (provider: string) => models.filter((model) => model.provider === provider),
    getModel: (provider: string, id: string) =>
      models.find((model) => model.id === id && model.provider === provider),
  };
  const api = {
    SessionManager: { create: () => manager, open: () => manager },
    SettingsManager: { inMemory: () => ({}) },
    createEventBus: () => ({ on: (name: string, handler: any) => events.set(name, handler) }),
    DefaultResourceLoader: class {
      constructor(options: any) {
        loaderOptions.push(options);
      }
      async reload() {}
      getExtensions() {
        return { errors: [] };
      }
    },
    createAgentSession: vi.fn(async (options) => {
      session.model = options.model;
      return { session };
    }),
    getSupportedThinkingLevels: () => ['medium'],
  };
  const fs = {
    mkdirSync: vi.fn(),
    existsSync: () => true,
    readFileSync: () => '',
    realpathSync: (file: string) => file,
  };
  const events = new Map<string, any>();
  const loaderOptions: any[] = [];
  const output: any[] = [];
  const helpers = {
    ...h,
    readIndex: () => index,
    writeIndex: vi.fn(),
  };
  const source = readFileSync(new URL('../docker/pi-host.cjs', import.meta.url), 'utf8');
  const service = runInNewContext(
    source.slice(0, source.lastIndexOf('main().catch(')) +
      '\nruntime = testRuntime; api = testApi; ({ handle, load, environment: process.env, isActive: () => active !== null, respond: (id, result) => pending.get(id).resolve(result) });',
    {
      require: (name: string) =>
        ({ 'node:fs': fs, 'node:path': path, 'node:crypto': crypto, './pi-session.cjs': helpers })[
          name
        ],
      __dirname: '/opt/repellet',
      process: {
        env: { PI_CODING_AGENT_SESSION_DIR: '/sessions', REPELLET_PI_MODEL: configuredModel },
        umask: vi.fn(),
        stdout: { write: (line: string) => output.push(JSON.parse(line)) },
      },
      testRuntime: runtime,
      testApi: api,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
    },
  );
  return { ...service, session, api, index, models, events, output, loaderOptions };
}

it('routes project extension requests through the current host turn and loads the bundled extension', async () => {
  const f = host();
  let finish!: () => void;
  f.session.prompt.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await f.handle({ method: 'thread/start' });
  const { turn } = await f.handle({
    method: 'turn/start',
    params: { threadId: 'thread', input: [{ type: 'text', text: 'Inspect app' }] },
  });
  const resolve = vi.fn(),
    reject = vi.fn();
  expect(f.loaderOptions[0].additionalExtensionPaths).toContain('/opt/pi/extensions/project.ts');
  f.events.get('repellet:project-control')({
    operation: 'status',
    arguments: {},
    signal: new AbortController().signal,
    resolve,
    reject,
  });
  const outbound = f.output.find((message) => message.method === 'repellet/project/control');
  expect(outbound).toMatchObject({
    params: { operation: 'status', arguments: {}, threadId: 'thread', turnId: turn.id },
  });
  expect(outbound.params).not.toHaveProperty('projectId');
  f.respond(outbound.id, { outcome: 'status' });
  await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith({ outcome: 'status' }));
  expect(reject).not.toHaveBeenCalled();
  finish();
});

it('routes resources through the active host turn and refreshes variables without restarting it', async () => {
  const f = host();
  let finish!: () => void;
  f.session.prompt.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await f.handle({ method: 'thread/start' });
  const { turn } = await f.handle({
    method: 'turn/start',
    params: { threadId: 'thread', input: [{ type: 'text', text: 'Inspect database' }] },
  });
  expect(f.loaderOptions[0].additionalExtensionPaths).toContain('/opt/pi/extensions/resources.ts');
  for (const variables of [{ DATABASE_URL: 'connection', TOKEN: 'value' }, { DB: 'connection' }]) {
    const resolve = vi.fn(),
      reject = vi.fn();
    f.events.get('repellet:resource-control')({
      operation: 'environment_sync',
      arguments: {},
      resolve,
      reject,
    });
    const outbound = f.output
      .filter((message) => message.method === 'repellet/resource/control')
      .at(-1);
    expect(outbound.params).toEqual({
      threadId: 'thread',
      turnId: turn.id,
      operation: 'environment_sync',
      arguments: {},
    });
    f.respond(outbound.id, { data: variables });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(reject).not.toHaveBeenCalled();
    expect(f.isActive()).toBe(true);
  }
  expect(f.environment).toMatchObject({ DB: 'connection' });
  expect(f.environment).not.toHaveProperty('TOKEN');
  expect(f.environment).not.toHaveProperty('DATABASE_URL');
  finish();
});

it('rejects project extension calls with no active host turn', async () => {
  const f = host();
  await f.handle({ method: 'thread/start' });
  await f.load('thread');
  const reject = vi.fn();
  f.events.get('repellet:project-control')({
    operation: 'start',
    arguments: {},
    resolve: vi.fn(),
    reject,
  });
  expect(reject).toHaveBeenCalledOnce();
  expect(f.output.some((message) => message.method === 'repellet/project/control')).toBe(false);
});

it('advertises exactly the newest Sol as the provider default', async () => {
  const f = host();
  const result = await f.handle({ method: 'model/list' });
  expect(
    result.data.filter((model: any) => model.isDefault).map((model: any) => model.model),
  ).toEqual(['gpt-6.1-sol']);
});

it('uses the newest Sol for new threads and default turns, including after a catalog update', async () => {
  const f = host();
  const result = await f.handle({ method: 'thread/start' });
  expect(result.thread.model).toBe('gpt-6.1-sol');
  const turn = { threadId: 'thread', model: '', input: [{ type: 'text', text: 'Hello' }] };
  await f.handle({ method: 'turn/start', params: turn });
  expect(f.api.createAgentSession.mock.calls[0][0].model.id).toBe('gpt-6.1-sol');
  await vi.waitFor(() => expect(f.isActive()).toBe(false));

  f.models.push({ ...catalog[0], id: 'gpt-6.2-sol' });
  await f.handle({ method: 'turn/start', params: turn });
  expect(f.session.model.id).toBe('gpt-6.2-sol');
  expect(f.index.sessions[0].model).toBe('gpt-6.2-sol');
});

it('honors an explicit model and returns to latest Sol when Default model is selected', async () => {
  const f = host();
  await f.handle({ method: 'thread/start', params: { model: 'openai-codex/gpt-6-astra' } });
  const turn = { threadId: 'thread', model: '', input: [{ type: 'text', text: 'Hello' }] };
  await f.handle({ method: 'turn/start', params: { ...turn, model: 'gpt-6-sol' } });
  expect(f.session.model.id).toBe('gpt-6-sol');
  await vi.waitFor(() => expect(f.isActive()).toBe(false));
  await f.handle({ method: 'turn/start', params: turn });
  expect(f.session.model.id).toBe('gpt-6.1-sol');
});

it('uses the same fallback for listing and running when no Sol model is available', async () => {
  const f = host([catalog[0]]);
  const result = await f.handle({ method: 'model/list' });
  expect(result.data[0].isDefault).toBe(true);
  await f.handle({ method: 'thread/start' });
  await f.handle({
    method: 'turn/start',
    params: { threadId: 'thread', input: [{ type: 'text', text: 'Hello' }] },
  });
  expect(f.session.model.id).toBe('gpt-5.3-codex-spark');
});

it('keeps a configured provider model as the default', async () => {
  const f = host([...catalog], 'gpt-6-astra');
  const result = await f.handle({ method: 'model/list' });
  expect(result.data.find((model: any) => model.isDefault).model).toBe('gpt-6-astra');
  await f.handle({ method: 'thread/start' });
  await f.handle({
    method: 'turn/start',
    params: { threadId: 'thread', input: [{ type: 'text', text: 'Hello' }] },
  });
  expect(f.session.model.id).toBe('gpt-6-astra');
});

it('falls back to latest Sol when the saved model is no longer available', async () => {
  const f = host();
  await f.handle({ method: 'thread/start', params: { model: 'removed-model' } });
  await f.handle({
    method: 'turn/start',
    params: { threadId: 'thread', input: [{ type: 'text', text: 'Hello' }] },
  });
  expect(f.api.createAgentSession.mock.calls[0][0].model.id).toBe('gpt-6.1-sol');
});

it('switches providers for overlapping model IDs without replacing the session and restores thread preferences', async () => {
  const proxy = { ...catalog[4], provider: 'repellet' } as (typeof catalog)[number];
  const f = host([...catalog, proxy]);
  await f.handle({ method: 'thread/start', params: { api: 'chatgpt', model: proxy.id } });
  await f.handle({
    method: 'turn/start',
    params: {
      threadId: 'thread',
      api: 'cliproxyapi',
      model: proxy.id,
      effort: 'high',
      input: [{ type: 'text', text: 'Use the proxy' }],
    },
  });
  await vi.waitFor(() => expect(f.isActive()).toBe(false));
  expect(f.session.model.provider).toBe('repellet');
  expect(f.api.createAgentSession).toHaveBeenCalledOnce();
  expect(
    (await f.handle({ method: 'thread/read', params: { threadId: 'thread' } })).thread,
  ).toMatchObject({ api: 'cliproxyapi', model: proxy.id, reasoningEffort: 'high' });
  await f.handle({
    method: 'thread/compact/start',
    params: { threadId: 'thread', api: 'chatgpt', model: proxy.id, effort: 'medium' },
  });
  expect(f.session.model.provider).toBe('openai-codex');
  expect(f.session.compact).toHaveBeenCalledOnce();
  expect(f.api.createAgentSession).toHaveBeenCalledOnce();
});
it('retains the last used model on omitted selection and rejects explicit unavailable models', async () => {
  const f = host();
  await f.handle({ method: 'thread/start', params: { model: 'gpt-6-sol' } });
  const params = { threadId: 'thread', input: [{ type: 'text', text: 'Continue' }] };
  await f.handle({ method: 'turn/start', params });
  await vi.waitFor(() => expect(f.isActive()).toBe(false));
  expect(f.session.model.id).toBe('gpt-6-sol');
  await expect(
    f.handle({ method: 'turn/start', params: { ...params, model: 'missing' } }),
  ).rejects.toThrow('unavailable');
  expect(f.session.prompt).toHaveBeenCalledOnce();
});

it('can switch a reopened thread away from a provider whose model was revoked', async () => {
  const f = host();
  await f.handle({
    method: 'thread/start',
    params: { api: 'cliproxyapi', model: 'removed-proxy-model' },
  });
  await f.handle({
    method: 'turn/start',
    params: {
      threadId: 'thread',
      api: 'chatgpt',
      model: 'gpt-6.1-sol',
      effort: null,
      input: [{ type: 'text', text: 'Continue with ChatGPT' }],
    },
  });
  await vi.waitFor(() => expect(f.isActive()).toBe(false));
  expect(f.session.model.provider).toBe('openai-codex');
  expect(f.api.createAgentSession).toHaveBeenCalledOnce();
  expect(f.session.prompt).toHaveBeenCalledOnce();
});
