import { PassThrough, Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  helpers: [] as any[],
  execOptions: [] as any[],
  running: true,
  refreshExit: 0,
}));
vi.mock('../apps/worker/src/workspaces.js', () => ({
  containerName: (id: string) => 'container-' + id,
  volumeName: (id: string, kind: string) => 'volume-' + id + '-' + kind,
  inspect: async () => ({ State: { Running: state.running } }),
  bridgeRequest: async () => new Response('{}'),
}));
vi.mock('../apps/worker/src/images.js', () => ({
  BASE_IMAGE: 'test-base-image',
  docker: {
    createContainer: async (options: any) => {
      const helper = {
        options,
        start: vi.fn(async () => {}),
        wait: vi.fn(async () => ({ StatusCode: state.refreshExit })),
        remove: vi.fn(async () => {}),
      };
      state.helpers.push(helper);
      return helper;
    },
    getContainer: () => ({
      inspect: async () => ({ Config: { Env: [] } }),
      exec: async (options: any) => {
        state.execOptions.push(options);
        return {
          start: async () => (options.AttachStdin ? new PassThrough() : Readable.from([])),
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
    }),
    modem: { demuxStream: vi.fn() },
  },
}));

import { startProjectProcess } from '../apps/worker/src/agent/process.js';
import { installManagedAgentContext } from '../apps/worker/src/agent-context.js';

beforeEach(() => {
  state.helpers.length = 0;
  state.execOptions.length = 0;
  state.running = true;
  state.refreshExit = 0;
});

it('refreshes private instructions on each agent restart without mounting or scanning workspace files', async () => {
  for (let restart = 0; restart < 2; restart++) {
    const connection = await startProjectProcess('project', {
      mode: 'custom',
      baseUrl: 'https://test.invalid',
      model: 'test-model',
      apiKey: 'test-key',
    });
    await connection.close();
  }
  expect(state.helpers).toHaveLength(2);
  for (const helper of state.helpers) {
    expect(helper.options.Cmd).toEqual([installManagedAgentContext]);
    expect(helper.options.Cmd[0]).not.toMatch(/chgrp|setfacl|find | -R |\/workspace/);
    expect(helper.options.Cmd[0]).toContain('chmod 700 /home/agent');
    expect(helper.options.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'volume-project-agent', Target: '/home/agent' },
    ]);
    expect(helper.remove).toHaveBeenCalledWith({ force: true });
  }
  expect(state.execOptions.filter((options) => options.AttachStdin)).toHaveLength(2);
});

it('does not start an agent after instruction refresh fails and cleans up its helper', async () => {
  state.refreshExit = 1;
  await expect(startProjectProcess('project', { mode: 'chatgpt' })).rejects.toThrow(
    'Could not refresh managed agent instructions',
  );
  expect(state.helpers[0].remove).toHaveBeenCalledWith({ force: true });
  expect(state.execOptions.some((options) => options.AttachStdin)).toBe(false);
});

it('does not prepare instructions or start an agent in a stopped workspace', async () => {
  state.running = false;
  await expect(startProjectProcess('project', { mode: 'chatgpt' })).rejects.toThrow(
    'Start the workspace to load agent conversations',
  );
  expect(state.helpers).toEqual([]);
  expect(state.execOptions).toEqual([]);
});

it('supplies both providers privately even when ChatGPT is the default API', async () => {
  const connection = await startProjectProcess(
    'project',
    {
      mode: 'chatgpt',
      baseUrl: 'https://global.invalid/v1',
      apiKey: 'global-private-key',
      model: '',
      effort: null,
      proxyModels: ['allowed', 'other'],
      defaults: {
        chatgpt: { model: '', effort: null },
        cliproxyapi: { model: 'allowed', effort: 'high' },
      },
    },
    { accessToken: 'chatgpt-private-token', chatgptAccountId: 'account', chatgptPlanType: 'plus' },
  );
  const exec = state.execOptions.find((options) => options.AttachStdin);
  expect(exec.Env).toEqual(
    expect.arrayContaining([
      'REPELLET_PI_PROVIDER=openai-codex',
      'REPELLET_AGENT_API_KEY=global-private-key',
      'REPELLET_CHATGPT_ACCESS_TOKEN=chatgpt-private-token',
      'REPELLET_PI_MODELS=["allowed","other"]',
    ]),
  );
  expect(exec.Cmd.join(' ')).not.toMatch(/global-private-key|chatgpt-private-token/);
  await connection.close();
});
