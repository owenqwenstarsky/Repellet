import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { fakeResponsesProvider } from './fake-responses-provider.mjs';
const h = createRequire(import.meta.url)('../docker/pi-session.cjs');
const roots: string[] = [];
const providers: Awaited<ReturnType<typeof fakeResponsesProvider>>[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function resources(root: string, eventBus = createEventBus()) {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, 'private'),
    eventBus,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    noExtensions: true,
    disabledBuiltinExtensions: ['mcp'],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: ['websearch.ts', 'plan.ts'].map((name) =>
      path.resolve('docker/pi-extensions', name),
    ),
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  return loader;
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repellet-extensions-'));
  roots.push(root);
  const provider = await fakeResponsesProvider();
  providers.push(provider);
  const eventBus = createEventBus();
  const loader = await resources(root, eventBus);
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('repellet', {
    baseUrl: provider.url.replace('host.docker.internal', '127.0.0.1'),
    api: 'openai-responses',
    models: [
      {
        id: 'fixture',
        name: 'Fixture',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
  await runtime.setRuntimeApiKey('repellet', 'private-search-key');
  const empty = SessionManager.create(root, root);
  await writeFile(empty.getSessionFile()!, JSON.stringify(empty.getHeader()) + '\n');
  const manager = SessionManager.open(empty.getSessionFile()!, root, root);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: path.join(root, 'private'),
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    modelRuntime: runtime,
    model: runtime.getModel('repellet', 'fixture'),
    resourceLoader: loader,
  });
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error) });
  return { root, provider, eventBus, session, manager, errors, loader };
}
it('loads the pinned extensions and runs the real /plan command without a model request', async () => {
  const { session, manager, provider, errors } = await fixture();
  await session.prompt('/plan');
  expect(h.planMode(manager)).toBe(true);
  expect(session.agent.state.tools.map((tool) => tool.name)).toContain('web_search');
  expect(session.agent.state.tools.map((tool) => tool.name)).toContain('plan');
  expect(session.agent.state.tools.map((tool) => tool.name)).not.toContain('write');
  expect(session.agent.state.tools.map((tool) => tool.name)).not.toContain('edit');
  const fork = SessionManager.forkFrom(
    manager.getSessionFile()!,
    manager.getCwd(),
    manager.getSessionDir(),
  );
  expect(h.planMode(fork)).toBe(true);
  await session.prompt('/plan');
  expect(h.planMode(manager)).toBe(false);
  expect(session.agent.state.tools.map((tool) => tool.name)).toContain('write');
  expect(session.agent.state.tools.map((tool) => tool.name)).not.toContain('ask_questions');
  expect(provider.requests).toHaveLength(0);
  expect(errors).toEqual([]);
});
it('blocks a shell write while planning and persists the blocked tool result', async () => {
  const { root, session, manager, errors } = await fixture();
  await session.prompt('/plan');
  await session.prompt('attempt a plan write');
  await expect(readFile(path.join(root, 'plan-disallowed.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(JSON.stringify(manager.buildSessionContext().messages)).toContain('Plan mode only allows');
  expect(errors).toEqual([]);
});
it('performs CLIProxyAPI web search over WebSockets using the in-memory key and active model', async () => {
  const { session, provider, manager, errors } = await fixture();
  await session.prompt('search current Pi docs');
  expect(provider.searches).toHaveLength(1);
  expect(provider.searches[0]).toMatchObject({
    authorizationPresent: true,
    beta: 'responses_websockets=2026-02-06',
    body: {
      type: 'response.create',
      model: 'fixture',
      tools: [{ type: 'web_search', search_context_size: 'medium' }],
    },
  });
  expect(JSON.stringify(provider.searches[0].body)).not.toContain('search current Pi docs');
  expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(
    'https://example.com/pi-docs',
  );
  expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(
    'private-search-key',
  );
  expect(errors).toEqual([]);
});
it('resolves ChatGPT auth afresh for every native search and forwards account-scoped SSE requests', async () => {
  const { loader } = await fixture();
  const tool = loader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.tools.values()])
    .find((tool) => tool.definition.name === 'web_search')!.definition;
  const auth = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      apiKey: 'first-token',
      headers: { 'chatgpt-account-id': 'account' },
    })
    .mockResolvedValueOnce({
      ok: true,
      apiKey: 'refreshed-token',
      headers: { 'chatgpt-account-id': 'account' },
    });
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                { type: 'web_search_call', status: 'completed' },
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'Fresh evidence', annotations: [] }],
                },
              ],
            },
          }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const ctx: any = {
    model: {
      id: 'gpt-5',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api',
    },
    modelRegistry: { getApiKeyAndHeaders: auth },
  };
  for (const token of ['first-token', 'refreshed-token']) {
    const result = await tool.execute(
      'search',
      { query: 'Latest Pi docs', search_context_size: 'low' },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(result.content[0]).toMatchObject({ text: 'Fresh evidence' });
    const [url, request] = fetch.mock.calls.at(-1)!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(request.headers.get('Authorization')).toBe('Bearer ' + token);
    expect(request.headers.get('chatgpt-account-id')).toBe('account');
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'gpt-5',
      stream: true,
      tools: [{ type: 'web_search' }],
    });
  }
  expect(auth).toHaveBeenCalledTimes(2);
});
it('presents browser planning questions and returns stable option values', async () => {
  const { session, eventBus, manager, errors } = await fixture();
  const questions: any[] = [];
  eventBus.on('repellet:question', (request: any) => {
    questions.push(request.questions);
    request.resolve({ answers: { scope: { answers: ['Focused'] } } });
  });
  await session.prompt('/plan');
  await session.prompt('ask planning choices');
  expect(questions[0][0]).toMatchObject({ id: 'scope', question: 'Which scope?' });
  expect(JSON.stringify(manager.buildSessionContext().messages)).toContain('focused');
  expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain(
    "require Pi's interactive TUI",
  );
  expect(errors).toEqual([]);
});
it('renders a completed plan and pauses for browser review before restoring write tools', async () => {
  const { session, eventBus, manager, errors, provider } = await fixture();
  const dialogs: any[] = [];
  eventBus.on('repellet:question', (request: any) => dialogs.push(request));
  await session.prompt('/plan');
  const turn = session.prompt('create a reviewed plan');
  await vi.waitFor(() => expect(dialogs).toHaveLength(1));
  expect(dialogs[0].questions[0].options.map((option: any) => option.label)).toEqual([
    'Implement the plan',
    'Make changes',
    'Keep planning',
  ]);
  expect(h.planMode(manager)).toBe(true);
  expect(h.transcript(manager).flatMap((turn: any) => turn.items)).toContainEqual(
    expect.objectContaining({ type: 'plan', text: expect.stringContaining('Update app.ts') }),
  );
  dialogs[0].resolve({ answers: { 'plan-review': { answers: ['Implement the plan'] } } });
  await turn;
  expect(h.planMode(manager)).toBe(false);
  expect(provider.requests.at(-1)?.toolNames.some((tool) => tool.name === 'write')).toBe(true);
  expect(errors).toEqual([]);
});
