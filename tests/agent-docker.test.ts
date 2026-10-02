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
        ['stat', '-c', '%u:%g:%a', '/home/agent', '/home/agent/.codex', managedAgentContextTarget],
        projectId,
      )
    ).text,
  ).toBe('1001:1001:700\n1001:1001:700\n1001:1001:444\n');
  expect(
    (await exec('1000:1000', ['test', '!', '-e', '/workspace/AGENTS.md'], projectId)).code,
  ).toBe(0);
}
describe.skipIf(!enabled)('real Codex 0.160.0 in the unprivileged workspace container', () => {
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
      environment: { SHARED_PROJECT_VARIABLE: 'available-to-agent' },
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
  it('pins Codex and denies shared terminals access to private state', async () => {
    expect((await exec('1000:1000', ['codex', '--version'])).text.trim()).toBe('codex-cli 0.160.0');
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
      environment: { SHARED_PROJECT_VARIABLE: 'available-to-agent' },
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
  it('initializes a real app-server and streams a response through a custom Responses endpoint', async () => {
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
    expect(JSON.stringify(result)).toContain('Codex is connected');
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
  it('uses Codex built-in command tools, excludes the provider key, and shares agent file changes with the bridge', async () => {
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
    expect(live.map((item) => item.type)).toEqual([
      'userMessage',
      'agentMessage',
      'commandExecution',
      'agentMessage',
    ]);
    const read = async () =>
      (await rpc('thread/read', { threadId: orderedThread, includeTurns: true })).thread.turns[0]
        .items;
    expect((await read()).map((item: any) => item.type)).toEqual(live.map((item) => item.type));
    await projects.stopAgent(id);
    const saved = await read();
    expect(saved.map((item: any) => item.type)).toEqual(live.map((item) => item.type));
    expect(saved[1].text).toBe('Checking the project.');
    expect(saved[3].text).toBe('Ordered final answer.');
  }, 60000);
  it('streams built-in patch diffs and recovers them from Codex history', async () => {
    const patchThread = (await rpc('thread/start')).thread.id;
    await rpc('turn/start', {
      threadId: patchThread,
      input: [{ type: 'text', text: 'apply agent patch' }],
    });
    await vi.waitFor(() => expect(projects.agentActivity(id).active).toBe(false), {
      timeout: 30000,
    });
    const live = await projects.agentStatus(id, userId);
    expect(live.items.some((entry) => entry.item.type === 'fileChange')).toBe(true);
    await projects.stopAgent(id);
    const saved = (await rpc('thread/read', { threadId: patchThread, includeTurns: true })).thread;
    expect(saved.turns[0].items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'fileChange',
          changes: [
            expect.objectContaining({
              path: expect.stringContaining('agent-patch.txt'),
              diff: expect.stringContaining('patched by agent'),
            }),
          ],
        }),
      ]),
    );
    expect((await exec('1000:1000', ['cat', '/workspace/agent-patch.txt'])).text).toBe(
      'patched by agent\n',
    );
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
  it('handles concurrent agent and workspace shutdown', async () => {
    await projects.agentStatus(id, userId);
    await Promise.all([projects.stopAgent(id), projects.stopAgent(id), worker.stopWorkspace(id)]);
    expect((await worker.inspect(id))?.State.Running).toBe(false);
    expect(projects.agentActivity(id).active).toBe(false);
  }, 60000);
});
