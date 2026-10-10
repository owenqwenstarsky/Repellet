import { describe, beforeAll, afterAll, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defaultLimits } from '@repellet/shared';
import { fakeResponsesProvider } from './fake-responses-provider.mjs';
import { PassThrough } from 'node:stream';
import { managedAgentContextTarget } from '../apps/worker/src/agent-context.js';
const enabled = process.env.RUN_DOCKER_TESTS === '1';
const id = randomUUID(),
  userId = randomUUID();
let worker: typeof import('../apps/worker/src/workspaces.js'),
  images: typeof import('../apps/worker/src/images.js'),
  projects: typeof import('../apps/worker/src/agent/projects.js'),
  accounts: typeof import('../apps/worker/src/agent/accounts.js');
let provider: Awaited<ReturnType<typeof fakeResponsesProvider>>,
  temp = '',
  threadId = '',
  managedContext = '';
async function rpc(method: string, params: unknown = {}) {
  return projects.agentRpc(id, userId, {
    generation: (await projects.agentStatus(id, userId)).generation,
    method,
    params,
  });
}
async function exec(user: string, command: string[], projectId = id) {
  const execution = await images.docker
    .getContainer(worker.containerName(projectId))
    .exec({ User: user, Cmd: command, AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true, stdin: false });
  const output = new PassThrough(),
    errors = new PassThrough();
  images.docker.modem.demuxStream(stream, output, errors);
  let text = '';
  output.on('data', (chunk) => {
    text += chunk;
  });
  errors.resume();
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return { text, code: (await execution.inspect()).ExitCode };
}
async function expectManagedContext(projectId = id) {
  expect(await exec('1001:1000', ['cat', managedAgentContextTarget], projectId)).toEqual({
    text: managedContext,
    code: 0,
  });
  expect((await exec('1000:1000', ['cat', managedAgentContextTarget], projectId)).code).not.toBe(0);
  expect(
    (
      await exec(
        '1001:1000',
        ['stat', '-c', '%u:%g:%a', '/home/agent', '/home/agent/.pi', managedAgentContextTarget],
        projectId,
      )
    ).text,
  ).toBe('1001:1001:700\n1001:1001:700\n1001:1001:444\n');
  expect(
    (await exec('1000:1000', ['test', '!', '-e', '/workspace/AGENTS.md'], projectId)).code,
  ).toBe(0);
}
describe.skipIf(!enabled)('real Pi 1.1.0 in the unprivileged workspace container', () => {
  beforeAll(async () => {
    managedContext = await readFile(
      new URL('../docker/agent-context/AGENTS.md', import.meta.url),
      'utf8',
    );
    temp = await mkdtemp(path.join(os.tmpdir(), 'repellet-agent-docker-'));
    process.env.AGENT_ACCOUNTS_HOME = temp;
    process.env.WORKER_TOKEN ||= 'agent-docker-tests-'.repeat(3);
    worker = await import('../apps/worker/src/workspaces.js');
    images = await import('../apps/worker/src/images.js');
    projects = await import('../apps/worker/src/agent/projects.js');
    accounts = await import('../apps/worker/src/agent/accounts.js');
    provider = await fakeResponsesProvider();
    await worker.ensureWorkspace(id, {
      runtimes: ['node'],
      limits: defaultLimits,
      environment: {
        SHARED_PROJECT_VARIABLE: 'available-to-agent',
        REPELLET_PI_EFFORT: 'invalid-effort',
        REPELLET_CHATGPT_ACCESS_TOKEN: 'injected-token',
      },
    });
    await accounts.saveSettings(userId, {
      mode: 'custom',
      baseUrl: provider.url,
      model: 'repellet-test-model',
      apiKey: 'private-provider-key',
    });
  }, 1200000);
  afterAll(async () => {
    if (projects) await projects.stopAgent(id);
    if (worker) await worker.removeWorkspace(id);
    if (provider) await provider.close();
    if (temp) await rm(temp, { recursive: true, force: true });
  });
  it('pins Pi and denies shared terminals access to private state', async () => {
    expect((await exec('1000:1000', ['pi', '--version'])).text.trim()).toBe('1.1.0');
    expect((await exec('1000:1000', ['codex', '--version'])).code).not.toBe(0);
    expect((await exec('1000:1000', ['/bin/sh', '-c', 'ls /home/agent'])).code).not.toBe(0);
    expect(
      (await worker.inspect(id))!.Mounts.some((mount) => mount.Name === `repellet-${id}-agent`),
    ).toBe(true);
    await expectManagedContext();
  });
  it('refreshes managed context when recreating an existing workspace and initializes duplicates', async () => {
    expect((await exec('1001:1000', ['rm', managedAgentContextTarget])).code).toBe(0);
    await worker.stopWorkspace(id);
    await images.docker.getContainer(worker.containerName(id)).remove();
    await worker.ensureWorkspace(id, {
      runtimes: ['node'],
      limits: defaultLimits,
      environment: {
        SHARED_PROJECT_VARIABLE: 'available-to-agent',
        REPELLET_PI_EFFORT: 'invalid-effort',
        REPELLET_CHATGPT_ACCESS_TOKEN: 'injected-token',
      },
    });
    await expectManagedContext();
    const duplicateId = randomUUID();
    try {
      await worker.duplicateWorkspace(id, duplicateId);
      await worker.ensureWorkspace(duplicateId, {
        runtimes: ['node'],
        limits: defaultLimits,
        environment: {},
      });
      await expectManagedContext(duplicateId);
    } finally {
      await worker.removeWorkspace(duplicateId);
    }
  }, 60000);
  it('initializes the Pi SDK host and streams a response through a custom Responses endpoint', async () => {
    const status = await projects.agentStatus(id, userId);
    expect(status.connected).toBe(true);
    threadId = (await rpc('thread/start')).thread.id;
    const empty = await rpc('thread/read', { threadId, includeTurns: true });
    expect(empty.thread.id).toBe(threadId);
    expect(empty.thread.turns).toEqual([]);
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Hello' }] });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    const result = await rpc('thread/read', { threadId, includeTurns: true });
    expect(result.thread.turns[0].status).toBe('completed');
    expect(JSON.stringify(result)).toContain('Agent is connected to Repellet');
    expect(JSON.stringify(result)).not.toContain('private-provider-key');
    expect(provider.requests[0]).toMatchObject({
      path: '/custom/v1/responses',
      model: 'repellet-test-model',
      authorizationPresent: true,
      agentContextPresent: true,
    });
  }, 60000);
  it('refreshes managed context on agent-process restart and sends it in new model requests', async () => {
    const old = (await projects.agentStatus(id, userId)).generation;
    await projects.stopAgent(id);
    expect(
      (
        await exec('1001:1000', [
          '/bin/sh',
          '-c',
          `rm ${managedAgentContextTarget} && printf 'stale context' > ${managedAgentContextTarget}`,
        ])
      ).code,
    ).toBe(0);
    const next = await projects.agentStatus(id, userId);
    expect(next.generation).not.toBe(old);
    await expectManagedContext();
    const contextThread = (await rpc('thread/start')).thread.id;
    const requestCount = provider.requests.length;
    await rpc('turn/start', {
      threadId: contextThread,
      input: [{ type: 'text', text: 'Hello again' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    expect(provider.requests.length).toBeGreaterThan(requestCount);
    expect(
      provider.requests.slice(requestCount).every((request) => request.agentContextPresent),
    ).toBe(true);
  }, 60000);
  it('preserves extended reasoning efforts in custom Responses requests', async () => {
    const reasoningThread = (await rpc('thread/start')).thread.id;
    for (const effort of ['xhigh', 'max', 'ultra']) {
      await projects.stopAgent(id);
      await accounts.saveSettings(userId, {
        mode: 'custom',
        baseUrl: provider.url,
        model: 'repellet-test-model',
        effort,
      });
      const before = provider.requests.length;
      await rpc('turn/start', {
        threadId: reasoningThread,
        effort,
        input: [{ type: 'text', text: `Use ${effort} reasoning` }],
      });
      await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
        timeout: 30000,
      });
      expect(provider.requests.slice(before).map((request) => request.reasoningEffort)).toEqual([
        effort,
      ]);
    }
    const models = (await rpc('model/list')).data;
    expect(models[0].supportedReasoningEfforts.map((entry: any) => entry.reasoningEffort)).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    await projects.stopAgent(id);
    await accounts.saveSettings(userId, {
      mode: 'custom',
      baseUrl: provider.url,
      model: 'repellet-test-model',
      effort: null,
    });
  }, 60000);
  it('uses Pi command tools, excludes the provider key, and shares agent file changes with the bridge', async () => {
    await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'create agent file' }] });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    const result = await rpc('thread/read', { threadId, includeTurns: true });
    expect(result.thread.turns.at(-1).status).toBe('completed');
    const streamed = await projects.agentStatus(id, userId);
    expect(
      result.thread.turns.at(-1).items.some((item: any) => item.type === 'commandExecution'),
    ).toBe(true);
    expect(JSON.stringify(streamed)).toContain('PROVIDER_KEY_HIDDEN');
    const file = (await (
      await worker.bridgeRequest(id, '/file?path=agent-result.txt')
    ).json()) as any;
    expect(file.content).toBe('created by agent\n');
    await worker.bridgeRequest(id, '/file', 'PUT', {
      path: 'agent-result.txt',
      content: 'edited through bridge',
      expectedHash: file.hash,
    });
    expect((await exec('1001:1000', ['cat', '/workspace/agent-result.txt'])).text).toBe(
      'edited through bridge',
    );
  }, 60000);
  it('preserves live message and tool order when loading history after process replacement', async () => {
    const orderedThread = (await rpc('thread/start')).thread.id;
    await rpc('turn/start', {
      threadId: orderedThread,
      input: [{ type: 'text', text: 'create agent file with ordered commentary' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    const live = (await projects.agentStatus(id, userId)).items
      .filter((entry) => entry.threadId === orderedThread)
      .map((entry) => entry.item)
      .filter((item) => ['userMessage', 'agentMessage', 'commandExecution'].includes(item.type));
    expect(live.map((item) => item.type)).toEqual(
      expect.arrayContaining(['userMessage', 'agentMessage', 'commandExecution']),
    );
    const read = async () =>
      (await rpc('thread/read', { threadId: orderedThread, includeTurns: true })).thread.turns[0]
        .items;
    expect(
      (await read())
        .filter((item: any) =>
          ['userMessage', 'agentMessage', 'commandExecution'].includes(item.type),
        )
        .map((item: any) => item.type),
    ).toEqual(live.map((item) => item.type));
    await projects.stopAgent(id);
    const saved = await read();
    expect(
      saved
        .filter((item: any) =>
          ['userMessage', 'agentMessage', 'commandExecution'].includes(item.type),
        )
        .map((item: any) => item.type),
    ).toEqual(live.map((item) => item.type));
    expect(saved[1].text).toBe('Checking the project.');
    expect(
      saved.find(
        (item: any) => item.type === 'agentMessage' && item.text === 'Ordered final answer.',
      ),
    ).toBeTruthy();
  }, 60000);
  it('streams built-in patch diffs and recovers them from Pi history', async () => {
    const patchThread = (await rpc('thread/start')).thread.id;
    await rpc('turn/start', {
      threadId: patchThread,
      input: [{ type: 'text', text: 'apply agent patch' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    expect((await exec('1001:1000', ['cat', '/workspace/agent-patch.txt'])).text).toBe(
      'patched by agent\n',
    );
    await projects.stopAgent(id);
    const saved = (await rpc('thread/read', { threadId: patchThread, includeTurns: true })).thread;
    expect(JSON.stringify(saved)).toContain('agent-patch.txt');
    expect((await exec('1000:1000', ['cat', '/workspace/agent-patch.txt'])).text).toBe(
      'patched by agent\n',
    );
  }, 60000);
  it('isolates browsing and metadata changes from active work and steers within one turn', async () => {
    const running = (await rpc('thread/start')).thread.id;
    const other = (await rpc('thread/start')).thread.id;
    const started = await rpc('turn/start', {
      threadId: running,
      input: [{ type: 'text', text: 'hold for steering' }],
    });
    await rpc('thread/read', { threadId: other, includeTurns: true });
    await rpc('thread/name/set', { threadId: other, name: 'Independent thread' });
    const fork = (await rpc('thread/fork', { threadId: other })).thread;
    expect(fork.parentThreadId).toBeNull();
    await rpc('thread/archive', { threadId: other });
    expect(
      (await rpc('thread/list', { archived: true })).data.some(
        (thread: any) => thread.id === other,
      ),
    ).toBe(true);
    await rpc('thread/unarchive', { threadId: other });
    expect((await projects.agentStatus(id, userId)).active).toEqual({
      threadId: running,
      turnId: started.turn.id,
    });
    await rpc('turn/steer', {
      threadId: running,
      expectedTurnId: started.turn.id,
      input: [{ type: 'text', text: 'Additional guidance' }],
    });
    expect((await projects.agentStatus(id, userId)).active?.turnId).toBe(started.turn.id);
    await rpc('turn/interrupt', { threadId: running, turnId: started.turn.id });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false));
    const models = (await rpc('model/list')).data;
    expect(models[0].supportedReasoningEfforts[0]).toHaveProperty('reasoningEffort');
    expect(
      (await exec('1001:1000', ['test', '!', '-e', '/home/agent/.pi/agent/auth.json'])).code,
    ).toBe(0);
    expect(
      (await exec('1001:1000', ['test', '!', '-e', '/home/agent/.pi/agent/models.json'])).code,
    ).toBe(0);
  }, 60000);
  it('waits for an owner question through the Pi SDK and resumes the same turn', async () => {
    const thread = (await rpc('thread/start')).thread.id;
    const started = await rpc('turn/start', {
      threadId: thread,
      input: [{ type: 'text', text: 'ask owner' }],
    });
    await vi.waitFor(async () =>
      expect((await projects.agentStatus(id, userId)).pending).toHaveLength(1),
    );
    const state = await projects.agentStatus(id, userId);
    expect(state.waiting).toBe(true);
    await rpc('question/respond', {
      requestId: state.pending[0].id,
      answers: { choice: { answers: ['First'] } },
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false));
    const history = (await rpc('thread/read', { threadId: thread, includeTurns: true })).thread;
    expect(history.turns[0].id).toBe(started.turn.id);
    expect(
      history.turns[0].items.some(
        (item: any) => item.type === 'dynamicToolCall' && item.tool === 'question' && item.success,
      ),
    ).toBe(true);
  }, 60000);
  it('bundles pinned extensions, persists /plan mode across restarts and forks, and blocks writes', async () => {
    const metadata = JSON.parse(
      (await exec('1000:1000', ['cat', '/opt/pi/extensions/upstream/sources.json'])).text,
    );
    expect(metadata.plan.commit).toBe('97258e39430d80dbc2e6a258e00a871252f83585');
    expect(metadata.websearch.commit).toBe('8531eff7ab9ba4b2cd45bccf88948450e66acd44');
    const planned = (await rpc('thread/start')).thread.id;
    const before = provider.requests.length;
    expect((await rpc('thread/plan/toggle', { threadId: planned })).thread.planMode).toBe(true);
    expect(provider.requests).toHaveLength(before);
    await projects.stopAgent(id);
    expect((await rpc('thread/read', { threadId: planned })).thread.planMode).toBe(true);
    const forked = (await rpc('thread/fork', { threadId: planned })).thread;
    expect(forked.planMode).toBe(true);
    await rpc('turn/start', {
      threadId: planned,
      input: [{ type: 'text', text: 'attempt a plan write' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    expect(
      (await exec('1001:1000', ['test', '!', '-e', '/workspace/plan-disallowed.txt'])).code,
    ).toBe(0);
    const turn = (
      await rpc('thread/read', { threadId: planned, includeTurns: true })
    ).thread.turns.at(-1);
    expect(JSON.stringify(turn)).toContain('Plan mode only allows');
    expect(provider.requests.at(-1).toolNames.some((tool) => tool.name === 'write')).toBe(false);
    expect(provider.requests.at(-1).toolNames.some((tool) => tool.name === 'web_search')).toBe(
      true,
    );
    expect((await rpc('thread/plan/toggle', { threadId: planned })).thread.planMode).toBe(false);
    expect((await rpc('thread/read', { threadId: forked.id })).thread.planMode).toBe(true);
  }, 60000);
  it('searches through the configured CLIProxyAPI Responses WebSocket without a credential file', async () => {
    const searched = (await rpc('thread/start')).thread.id;
    const before = provider.searches.length;
    await rpc('turn/start', {
      threadId: searched,
      input: [{ type: 'text', text: 'search current Pi docs' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    expect(provider.searches.slice(before)).toMatchObject([
      {
        authorizationPresent: true,
        body: { model: 'repellet-test-model', tools: [{ type: 'web_search' }] },
      },
    ]);
    const history = (await rpc('thread/read', { threadId: searched, includeTurns: true })).thread;
    expect(JSON.stringify(history)).toContain('https://example.com/pi-docs');
    expect(JSON.stringify(history)).not.toContain('private-provider-key');
    expect(
      (
        await exec('1001:1000', [
          'test',
          '!',
          '-e',
          '/home/agent/.pi/agent/pi-cliproxyapi-provider/config.json',
        ])
      ).code,
    ).toBe(0);
  }, 60000);
  it('pauses for browser planning questions and plan review, and implements only after an answer', async () => {
    const planned = (await rpc('thread/start')).thread.id;
    await rpc('thread/plan/toggle', { threadId: planned });
    await rpc('turn/start', {
      threadId: planned,
      input: [{ type: 'text', text: 'create a reviewed plan' }],
    });
    await vi.waitFor(async () =>
      expect((await projects.agentStatus(id, userId)).waiting).toBe(true),
    );
    const review = (await projects.agentStatus(id, userId)).pending[0];
    expect(review.params.questions[0].header).toBe('Plan review');
    const history = (await rpc('thread/read', { threadId: planned, includeTurns: true })).thread;
    expect(history.turns.at(-1).items).toContainEqual(
      expect.objectContaining({ type: 'plan', text: expect.stringContaining('Update app.ts') }),
    );
    await expect(rpc('thread/plan/toggle', { threadId: planned })).rejects.toThrow('active');
    await rpc('question/respond', {
      requestId: review.id,
      answers: { 'plan-review': { answers: ['Implement the plan'] } },
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    expect((await rpc('thread/read', { threadId: planned })).thread.planMode).toBe(false);
    expect(provider.requests.at(-1).toolNames.some((tool) => tool.name === 'write')).toBe(true);
    expect((await projects.agentStatus(id, userId)).pending).toEqual([]);
  }, 60000);
  it('interrupts an unanswered plan review and clears its pending browser question', async () => {
    const planned = (await rpc('thread/start')).thread.id;
    await rpc('thread/plan/toggle', { threadId: planned });
    const started = await rpc('turn/start', {
      threadId: planned,
      input: [{ type: 'text', text: 'create a reviewed plan' }],
    });
    await vi.waitFor(async () =>
      expect((await projects.agentStatus(id, userId)).waiting).toBe(true),
    );
    await rpc('turn/interrupt', { threadId: planned, turnId: started.turn.id });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false));
    expect((await projects.agentStatus(id, userId)).pending).toEqual([]);
    const saved = (await rpc('thread/read', { threadId: planned, includeTurns: true })).thread;
    expect(saved.turns.at(-1).status).toBe('interrupted');
    expect(saved.planMode).toBe(true);
  }, 60000);
  it('redacts echoed provider credentials from streamed events and canonical Pi history', async () => {
    const thread = (await rpc('thread/start')).thread.id;
    await rpc('turn/start', {
      threadId: thread,
      input: [{ type: 'text', text: 'echo provider credential' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false));
    const snapshot = await projects.agentStatus(id, userId);
    expect(JSON.stringify(snapshot)).not.toContain('private-provider-key');
    const result = (await rpc('thread/read', { threadId: thread, includeTurns: true })).thread;
    expect(result.turns[0].items.at(-1).text).toBe('Provider returned [redacted]');
    const read = `const fs=require('fs');const index=JSON.parse(fs.readFileSync('/home/agent/.pi/agent/repellet-sessions.json'));const entry=index.sessions.find(entry=>entry.threadId===${JSON.stringify(thread)});process.stdout.write(fs.readFileSync(entry.sessionFile));`;
    const canonical = (await exec('1001:1000', ['node', '-e', read])).text;
    expect(canonical).not.toContain('private-provider-key');
    expect(canonical).toContain('[redacted]');
  }, 60000);
  it('keeps histories across process replacement and aggregates private storage', async () => {
    const old = (await projects.agentStatus(id, userId)).generation;
    await projects.stopAgent(id);
    const next = await projects.agentStatus(id, userId);
    expect(next.generation).not.toBe(old);
    const saved = (await rpc('thread/read', { threadId, includeTurns: true })).thread;
    expect(saved.turns).toHaveLength(2);
    expect(JSON.stringify(saved)).toContain('PROVIDER_KEY_HIDDEN');
    expect(saved.turns[1].items.some((item: any) => item.type === 'commandExecution')).toBe(true);
    const usage = await projects.agentUsage(id);
    expect(usage.bytes).toBeGreaterThan(0);
    expect(usage.exceeded).toBe(false);
    await worker.bridgeRequest(id, '/limits', 'PUT', { storageMb: 0 });
    await expect(
      rpc('turn/start', { threadId, input: [{ type: 'text', text: 'no room' }] }),
    ).rejects.toThrow('storage limit');
  }, 60000);
  it('recovers an empty canonical session after interruption between session and index writes', async () => {
    const empty = (await rpc('thread/start')).thread;
    await rpc('thread/name/set', { threadId: empty.id, name: 'Recovered empty thread' });
    await projects.stopAgent(id);
    const edit = `const fs=require('fs');const file='/home/agent/.pi/agent/repellet-sessions.json';const index=JSON.parse(fs.readFileSync(file));index.sessions=index.sessions.filter(entry=>entry.threadId!==${JSON.stringify(empty.id)});fs.writeFileSync(file,JSON.stringify(index));`;
    expect((await exec('1001:1000', ['node', '-e', edit])).code).toBe(0);
    const recovered = (await rpc('thread/read', { threadId: empty.id, includeTurns: true })).thread;
    expect(recovered.name).toBe('Recovered empty thread');
    expect(recovered.turns).toEqual([]);
  }, 60000);
  it('imports a project-volume Codex conversation and continues it through Pi', async () => {
    await worker.bridgeRequest(id, '/limits', 'PUT', { storageMb: defaultLimits.storageMb });
    await projects.stopAgent(id);
    const original =
      [
        {
          type: 'session_meta',
          timestamp: '2026-10-01T12:00:00Z',
          payload: { name: 'Imported workspace history', model: 'repellet-test-model' },
        },
        {
          type: 'response_item',
          timestamp: '2026-10-01T12:00:01Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Earlier work' }],
          },
        },
        {
          type: 'response_item',
          timestamp: '2026-10-01T12:00:02Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Earlier answer' }],
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n';
    const source = '/home/agent/.codex/sessions/2026/10/old.jsonl';
    expect(
      (
        await exec('1001:1000', [
          'node',
          '-e',
          `const fs=require('fs');fs.mkdirSync('/home/agent/.codex/sessions/2026/10',{recursive:true});fs.writeFileSync(${JSON.stringify(source)},${JSON.stringify(original)});`,
        ])
      ).code,
    ).toBe(0);
    expect(await accounts.importExistingHistory(userId, [id])).toMatchObject({
      imported: 1,
      errors: [],
    });
    const imported = (await rpc('thread/list')).data.find(
      (thread: any) => thread.name === 'Imported workspace history',
    );
    expect(imported).toBeTruthy();
    // Imported Codex history retains ChatGPT as its API. Continuing through the
    // fixture proxy requires an explicit selection rather than a silent fallback.
    await rpc('turn/start', {
      threadId: imported.id,
      api: 'cliproxyapi',
      model: 'repellet-test-model',
      input: [{ type: 'text', text: 'Continue the imported work' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    const history = (await rpc('thread/read', { threadId: imported.id, includeTurns: true }))
      .thread;
    expect(history.turns).toHaveLength(2);
    expect(history.turns[0].items.map((item: any) => item.text || item.content?.[0]?.text)).toEqual(
      ['Earlier work', 'Earlier answer'],
    );
    expect(history.turns[1].items.at(-1).text).toContain('Agent is connected');
    await projects.stopAgent(id);
    expect(await accounts.importExistingHistory(userId, [id])).toMatchObject({
      imported: 0,
      skipped: 1,
    });
    expect((await exec('1001:1000', ['cat', source])).text).toBe(original);
    await expect(
      rpc('thread/read', { threadId: randomUUID(), includeTurns: true }),
    ).rejects.toThrow('Unknown thread');
  }, 60000);
  it('handles concurrent agent and workspace shutdown', async () => {
    await projects.agentStatus(id, userId);
    await Promise.all([projects.stopAgent(id), projects.stopAgent(id), worker.stopWorkspace(id)]);
    expect((await worker.inspect(id))?.State.Running).toBe(false);
    expect(projects.agentActivity(id).active).toBe(false);
  }, 60000);
});
