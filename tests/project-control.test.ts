import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  users,
  installation,
  projectRunProfiles,
  workspaceProcesses,
} from '../apps/api/src/schema.js';

const state = vi.hoisted(() => ({
  project: {} as any,
  profile: {} as any,
  pending: [] as any[],
  live: [] as any[],
  outputs: new Map<string, any>(),
  authorized: true,
  maintenance: false,
}));
vi.mock('../apps/api/src/db.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === users) return [{ id: 'owner', displayName: 'Owner' }];
          if (table === installation) return [{ maintenance: state.maintenance }];
          if (table === projectRunProfiles) return state.profile ? [state.profile] : [];
          if (table === workspaceProcesses) return state.pending;
          throw new Error('Unexpected table');
        },
      }),
    }),
  },
}));
vi.mock('../apps/api/src/config.js', () => ({ config: { workerToken: 'test-worker-token' } }));
vi.mock('../apps/api/src/security.js', () => ({
  projectAgentAccess: vi.fn(async () => {
    if (!state.authorized)
      throw Object.assign(new Error('private auth detail'), { statusCode: 403 });
    return state.project;
  }),
  tokenMatches: (provided: string, expected: string) => provided === expected,
}));
vi.mock('../apps/api/src/lifecycle.js', async () => {
  const { WorkspaceQueue } = await import('../apps/api/src/workspaceQueue.js');
  const queue = new WorkspaceQueue();
  return { serialize: <T>(id: string, fn: () => Promise<T>) => queue.run(id, fn) };
});
vi.mock('../apps/api/src/worker.js', () => ({ bridge: vi.fn() }));
vi.mock('../apps/api/src/preparation.js', () => ({
  mainRunProcessIds: vi.fn(),
  assertPrepared: vi.fn(),
  probePreview: vi.fn(),
  cancelReadiness: vi.fn(),
}));
vi.mock('../apps/api/src/processes.js', () => ({ startProfile: vi.fn(), stopProcess: vi.fn() }));
vi.mock('../apps/api/src/collaboration.js', () => ({ flushProject: vi.fn() }));
vi.mock('../apps/api/src/live.js', () => ({ emit: vi.fn() }));

import { projectControl, projectControlRoutes } from '../apps/api/src/projectControl.js';
import { bridge } from '../apps/api/src/worker.js';
import { startProfile, stopProcess } from '../apps/api/src/processes.js';
import { flushProject } from '../apps/api/src/collaboration.js';
import {
  mainRunProcessIds,
  assertPrepared,
  cancelReadiness,
  probePreview,
} from '../apps/api/src/preparation.js';
import { projectAgentAccess } from '../apps/api/src/security.js';
import type { ProjectControlInput } from '@repellet/agent-protocol';

const main = () => ({ id: 'main', name: 'Main app', isRun: true, alive: true });
const control = (operation: ProjectControlInput['operation'], args = {}) =>
  projectControl('project', 'owner', { operation, arguments: args } as ProjectControlInput);

beforeEach(() => {
  vi.resetAllMocks();
  state.project = {
    id: 'project',
    state: 'running',
    starterId: null,
    setupCommand: '',
    storageExceeded: false,
    preparation: { status: 'ready', error: null, scaffolded: true },
    appStatus: { status: 'timeout' },
    runConfig: { port: 3000 },
  };
  state.profile = { id: 'profile', name: 'Main app', command: 'npm run dev', cwd: '' };
  state.pending = [];
  state.live = [];
  state.outputs.clear();
  state.authorized = true;
  state.maintenance = false;
  vi.mocked(mainRunProcessIds).mockResolvedValue(new Set(['run', 'main', 'second']));
  vi.mocked(bridge).mockImplementation(async (_id, path) => {
    if (path === '/terminals') return structuredClone(state.live);
    if (path === '/health')
      return { protocolVersion: 1, capabilities: ['terminal-output', 'processes'] };
    if (path === '/run/stop') {
      state.live = state.live.filter((p) => p.id !== 'run');
      return { ok: true };
    }
    const id = path.match(/^\/terminals\/([^/]+)\/output/)?.[1];
    if (id) return state.outputs.get(id) ?? { running: false };
    throw new Error('Unexpected bridge path: ' + path);
  });
  vi.mocked(startProfile).mockImplementation(async () => {
    state.live.push(main());
    return { id: 'main' } as any;
  });
  vi.mocked(stopProcess).mockImplementation(async (_id, processId) => {
    state.live = state.live.filter((p) => p.id !== processId);
  });
});

it('reports live running state independently of failed preview readiness and ignores other processes', async () => {
  state.live = [
    main(),
    { id: 'other', name: 'Other app', isRun: true, alive: true },
    { id: 'shell', name: 'Shell', isRun: false, alive: true },
  ];
  const result = await control('status');
  expect(result).toMatchObject({
    outcome: 'status',
    status: { runState: 'running', preview: { status: 'timeout' }, command: 'npm run dev' },
  });
  expect(result.status!.processes.map((p) => p.id)).toEqual(['main']);
  expect(startProfile).not.toHaveBeenCalled();
  expect(flushProject).not.toHaveBeenCalled();
  expect(probePreview).not.toHaveBeenCalled();
});

it.each(['stopped', 'building', 'starting', 'stopping', 'failed'])(
  'does not start or query a %s workspace',
  async (workspaceState) => {
    state.project.state = workspaceState;
    expect(await control('status')).toMatchObject({
      status: { workspaceState, runState: 'not_running' },
    });
    expect(await control('logs')).toMatchObject({ outcome: 'not_running' });
    expect(await control('start')).toMatchObject({
      outcome: 'error',
      error: { code: 'start_blocked' },
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(startProfile).not.toHaveBeenCalled();
  },
);

it.each(['status', 'logs', 'start', 'stop'] as const)(
  'treats a failed live check as unknown for %s',
  async (operation) => {
    vi.mocked(bridge).mockRejectedValue(new Error('secret bridge credential'));
    const result = await control(operation);
    expect(result).toMatchObject({
      outcome: 'error',
      status: { runState: 'unknown' },
      error: { code: 'status_unavailable' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(startProfile).not.toHaveBeenCalled();
    expect(stopProcess).not.toHaveBeenCalled();
  },
);

it('preserves both current and legacy apps on start, and makes repeated stop a no-op', async () => {
  state.live = [main(), { ...main(), id: 'run' }, { ...main(), id: 'other' }];
  expect(await control('start')).toMatchObject({ outcome: 'already_running' });
  expect(startProfile).not.toHaveBeenCalled();
  expect(await control('stop')).toMatchObject({
    outcome: 'stopped',
    status: { runState: 'not_running' },
  });
  expect(stopProcess).toHaveBeenCalledExactlyOnceWith('project', 'main');
  expect(bridge).toHaveBeenCalledWith('project', '/run/stop', 'POST');
  expect(state.live.map((p) => p.id)).toEqual(['other']);
  expect(cancelReadiness).toHaveBeenCalledOnce();
  vi.mocked(bridge).mockClear();
  expect(await control('stop')).toMatchObject({ outcome: 'not_running' });
  expect(bridge).toHaveBeenCalledExactlyOnceWith('project', '/terminals');
});

it('serializes concurrent starts and rechecks the second request after the first spawn', async () => {
  const results = await Promise.all([control('start'), control('start')]);
  expect(results.map((r) => r.outcome)).toEqual(['started', 'already_running']);
  expect(startProfile).toHaveBeenCalledOnce();
  expect(startProfile).toHaveBeenCalledWith('project', 'profile', 'owner', 'run', undefined);
  expect(flushProject).toHaveBeenCalledOnce();
  expect(assertPrepared).toHaveBeenCalledOnce();
  expect(probePreview).toHaveBeenCalledWith('project', 3000);
});

it('does not duplicate an unresolved start, even when the pending record is old', async () => {
  state.pending = [{ id: 'main', createdAt: new Date(0) }];
  for (const operation of ['status', 'start', 'stop'] as const) {
    const result = await control(operation);
    expect(result.status?.runState).toBe('starting');
  }
  expect(startProfile).not.toHaveBeenCalled();
  expect(stopProcess).not.toHaveBeenCalled();
  expect(await control('logs')).toMatchObject({
    outcome: 'not_running',
    status: { runState: 'starting' },
  });
});

it('reports malformed process responses as unknown instead of treating them as stopped', async () => {
  state.live = [{ id: 'main', name: 'Main', isRun: true }];
  expect(await control('start')).toMatchObject({
    error: { code: 'status_unavailable' },
    status: { runState: 'unknown' },
  });
  expect(startProfile).not.toHaveBeenCalled();
});

it('does not disturb a running app while an older unresolved record also exists', async () => {
  state.live = [main()];
  state.pending = [{ id: 'second' }];
  expect(await control('start')).toMatchObject({ outcome: 'already_running' });
  state.outputs.set('main', { running: true, text: 'current output' });
  expect(await control('logs')).toMatchObject({
    outcome: 'logs',
    logs: [{ processId: 'main', text: 'current output' }],
  });
  expect(startProfile).not.toHaveBeenCalled();
});

it('reports a rebuild requirement before starting on an incompatible workspace', async () => {
  vi.mocked(bridge).mockImplementation(async (_id, path) =>
    path === '/terminals' ? [] : { protocolVersion: 0, capabilities: [] },
  );
  expect(await control('start')).toMatchObject({ error: { code: 'rebuild_required' } });
  expect(startProfile).not.toHaveBeenCalled();
});

it('reports uncertain post-spawn status without claiming that the app is stopped', async () => {
  vi.mocked(startProfile).mockImplementation(async () => {
    vi.mocked(bridge).mockRejectedValue(new Error('status transport failed'));
    return { id: 'main' } as any;
  });
  expect(await control('start')).toMatchObject({
    outcome: 'error',
    error: { uncertain: true },
    status: { runState: 'unknown' },
  });
  expect(startProfile).toHaveBeenCalledOnce();
});

it.each(['exited', 'failed', 'stopped'])(
  'does not return historical output for an app that %s',
  async (status) => {
    state.live = [{ ...main(), alive: false, status }];
    state.outputs.set('main', { running: true, text: 'old output' });
    expect(await control('logs')).toMatchObject({
      outcome: 'not_running',
      status: { runState: 'not_running' },
    });
    expect(bridge).toHaveBeenCalledExactlyOnceWith('project', '/terminals');
  },
);

it('labels live log segments, bounds their combined UTF-8 bytes, and passes line limits', async () => {
  state.live = [main(), { ...main(), id: 'second' }];
  state.outputs.set('main', { running: true, text: 'é'.repeat(30000), truncated: false });
  state.outputs.set('second', { running: true, text: '😀'.repeat(30000), truncated: false });
  const result = await control('logs', { tailLines: 1000 });
  expect(result.outcome).toBe('logs');
  expect(result.logs?.map((log) => log.processId)).toEqual(['main', 'second']);
  expect(
    result.logs?.reduce((sum, log) => sum + Buffer.byteLength(log.text), 0),
  ).toBeLessThanOrEqual(65536);
  expect(JSON.stringify(result)).not.toContain('�');
  expect(result.truncated).toBe(true);
  expect(bridge).toHaveBeenCalledWith('project', '/terminals/main/output?tailLines=1000');
});

it('returns not running if the app exits between listing processes and reading output', async () => {
  state.live = [main()];
  expect(await control('logs')).toMatchObject({
    outcome: 'not_running',
    status: { runState: 'not_running', processes: [] },
  });
});

it('reports the rebuild requirement for a bridge without output support', async () => {
  state.live = [main()];
  vi.mocked(bridge).mockImplementation(async (_id, path) =>
    path === '/terminals' ? state.live : { capabilities: [] },
  );
  expect(await control('logs')).toMatchObject({
    error: { code: 'rebuild_required', message: expect.stringContaining('Rebuild') },
  });
});

it.each(['command', 'preparation', 'storage', 'profile', 'maintenance'])(
  'blocks start for %s without spawning',
  async (reason) => {
    if (reason === 'command') state.profile.command = ' ';
    if (reason === 'preparation') {
      state.project.setupCommand = 'npm ci';
      state.project.preparation.status = 'failed';
    }
    if (reason === 'storage') state.project.storageExceeded = true;
    if (reason === 'profile') state.profile = null;
    if (reason === 'maintenance') state.maintenance = true;
    expect(await control('start')).toMatchObject({ outcome: 'error' });
    expect(startProfile).not.toHaveBeenCalled();
  },
);

it('rechecks owner access after flushing and leaves revoked access out of the result', async () => {
  vi.mocked(flushProject).mockImplementation(async () => {
    state.authorized = false;
  });
  expect(await control('start')).toEqual({
    outcome: 'error',
    status: undefined,
    error: {
      code: 'access_denied',
      message: 'Enabled project owner access is required for these tools.',
    },
  });
  expect(projectAgentAccess).toHaveBeenCalledTimes(2);
  expect(startProfile).not.toHaveBeenCalled();
});

it('does not admit an aborted mutation after waiting for the lock', async () => {
  const controller = new AbortController();
  let release!: () => void;
  vi.mocked(flushProject).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = control('start');
  await vi.waitFor(() => expect(flushProject).toHaveBeenCalledOnce());
  const second = projectControl(
    'project',
    'owner',
    { operation: 'stop', arguments: {} },
    controller.signal,
  );
  controller.abort();
  release();
  await first;
  expect(await second).toMatchObject({ error: { code: 'cancelled' } });
  expect(stopProcess).not.toHaveBeenCalled();
});

it('reports uncertain spawn failures without replaying the mutation', async () => {
  vi.mocked(startProfile).mockRejectedValue(new Error('private environment secret'));
  const result = await control('start');
  expect(result).toMatchObject({
    error: { uncertain: true, message: expect.stringContaining('project_status') },
  });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(startProfile).toHaveBeenCalledOnce();
});

it('authenticates internal requests and rejects arbitrary arguments entirely in memory', async () => {
  const app = Fastify();
  await projectControlRoutes(app);
  const payload = {
    projectId: randomUUID(),
    userId: randomUUID(),
    control: { operation: 'status', arguments: {} },
  };
  try {
    expect(
      (await app.inject({ method: 'POST', url: '/internal/agent/project-control', payload }))
        .statusCode,
    ).toBe(401);
    const headers = { authorization: 'Bearer test-worker-token' };
    for (const control of [
      { operation: 'start', arguments: { command: 'rm -rf /' } },
      { operation: 'stop', arguments: { processId: 'other' } },
      { operation: 'logs', arguments: { tailLines: 1001 } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/agent/project-control',
        headers,
        payload: { ...payload, control },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(startProfile).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/agent/project-control',
          headers,
          payload,
        })
      ).json(),
    ).toMatchObject({ outcome: 'status' });
  } finally {
    await app.close();
  }
});
