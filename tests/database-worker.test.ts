import { PassThrough } from 'node:stream';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  volume: false,
  network: false,
  container: null as any,
  workspace: { Id: 'workspace', NetworkSettings: { Networks: {} as Record<string, unknown> } },
  creates: [] as any[],
  calls: [] as string[],
  executions: [] as any[],
  volumeError: false,
  execFailure: false,
}));
vi.mock('../apps/worker/src/config.js', () => ({ projectId: (id: string) => id }));
vi.mock('../apps/worker/src/images.js', () => ({
  BASE_IMAGE: 'base',
  docker: {
    getImage: () => ({ inspect: async () => ({}) }),
    getNetwork: (name: string) => ({
      inspect: async () => {
        if (!state.network) throw { statusCode: 404 };
        return { Containers: { workspace: {} } };
      },
      connect: async () => {
        state.calls.push('connect');
        state.workspace.NetworkSettings.Networks[name] = {};
      },
      disconnect: async () => {
        state.calls.push('disconnect');
      },
      remove: async () => {
        state.calls.push('network.remove');
        state.network = false;
      },
    }),
    createNetwork: async (options: any) => {
      state.creates.push({ network: options });
      state.network = true;
    },
    getVolume: () => ({
      inspect: async () => {
        if (!state.volume) throw { statusCode: 404 };
        return {};
      },
      remove: async () => {
        state.calls.push('volume.remove');
        if (state.volumeError) throw { statusCode: 409 };
        state.volume = false;
      },
    }),
    createVolume: async (options: any) => {
      state.creates.push({ volume: options });
      state.volume = true;
    },
    getContainer: (name: string) => ({
      inspect: async () => {
        if (name === 'workspace') return state.workspace;
        if (!state.container) throw { statusCode: 404 };
        return state.container;
      },
      start: async () => {
        state.calls.push('start');
        state.container.State.Running = true;
      },
      stop: async () => {
        state.calls.push('stop');
        state.container.State.Running = false;
      },
      remove: async () => {
        state.calls.push('container.remove');
        state.container = null;
      },
      exec: async (options: any) => {
        state.executions.push(options);
        if (state.execFailure) throw new Error('not ready');
        return {
          start: async () => {
            const stream = new PassThrough();
            if (!options.AttachStdin) setTimeout(() => stream.end('ready'), 0);
            return stream;
          },
          inspect: async () => ({ ExitCode: 0 }),
        };
      },
    }),
    createContainer: async (options: any) => {
      state.creates.push({ container: options });
      state.container = {
        Id: options.name,
        Config: { Labels: options.Labels },
        State: { Running: false },
      };
      return {
        start: async () => {
          state.calls.push('start');
          state.container.State.Running = true;
        },
        inspect: async () => state.container,
      };
    },
    modem: { demuxStream: (stream: PassThrough, output: PassThrough) => stream.pipe(output) },
  },
}));
import {
  ensureDatabase,
  databaseSpecSchema,
  databaseUrl,
  stopDatabase,
  removeDatabase,
} from '../apps/worker/src/databases.js';
const id = '11111111-1111-4111-8111-111111111111';
const spec = databaseSpecSchema.parse({
  id: '22222222-2222-4222-8222-222222222222',
  type: 'postgresql',
  image: 'postgres:17-alpine',
  initialize: true,
  password: 'a'.repeat(64),
  adminPassword: 'b'.repeat(64),
});
beforeEach(() => {
  state.volume = false;
  state.network = false;
  state.container = null;
  state.workspace = { Id: 'workspace', NetworkSettings: { Networks: {} } };
  state.creates = [];
  state.calls = [];
  state.executions = [];
  state.volumeError = false;
  state.execFailure = false;
});
afterEach(() => vi.useRealTimers());
it('provisions an isolated, capped container with separate credentials and no published ports', async () => {
  expect(await ensureDatabase(id, spec, 'workspace')).toMatchObject({ status: 'ready' });
  const create = state.creates.find((entry) => entry.container).container;
  expect(create.Image).toBe('postgres:17-alpine');
  expect(create.HostConfig).toMatchObject({
    NetworkMode: `repellet-database-${id}`,
    Memory: 1024 ** 3,
    NanoCpus: 1e9,
  });
  expect(create.HostConfig).not.toHaveProperty('PortBindings');
  expect(create.Labels).not.toHaveProperty('repellet.managed');
  expect(create.Env.join(' ')).toContain(spec.adminPassword);
  expect(create.Env.join(' ')).not.toContain(spec.password);
  expect(state.creates.find((entry) => entry.network).network.Internal).toBe(true);
  expect(state.executions.some((execution) => execution.Cmd[0] === 'psql')).toBe(true);
  expect(state.executions.flatMap((execution) => execution.Cmd).join(' ')).not.toContain(
    spec.password,
  );
  expect(databaseUrl(id, spec)).toContain(`@repellet-database-${id}:5432`);
});
it('keeps the volume across stops/restarts and refuses to silently replace missing initialized data', async () => {
  await ensureDatabase(id, spec, 'workspace');
  await stopDatabase(id);
  expect(state.volume).toBe(true);
  const count = state.creates.length;
  await ensureDatabase(id, { ...spec, initialize: false }, 'workspace');
  expect(state.creates).toHaveLength(count);
  expect(state.calls.filter((call) => call === 'connect')).toHaveLength(1);
  state.volume = false;
  await expect(ensureDatabase(id, { ...spec, initialize: false }, 'workspace')).rejects.toThrow(
    'could not start',
  );
  expect(state.creates).toHaveLength(count);
});
it('retains partial deletion for retry and removes the network only after the volume', async () => {
  await ensureDatabase(id, spec, 'workspace');
  state.volumeError = true;
  await expect(removeDatabase(id)).rejects.toEqual({ statusCode: 409 });
  expect(state.volume).toBe(true);
  expect(state.network).toBe(true);
  state.volumeError = false;
  await removeDatabase(id);
  expect(state.volume).toBe(false);
  expect(state.network).toBe(false);
  expect(state.calls.indexOf('volume.remove')).toBeLessThan(state.calls.indexOf('network.remove'));
  await removeDatabase(id);
});
it('does not attach a different database identity and keeps startup failures recoverable', async () => {
  await ensureDatabase(id, spec, 'workspace');
  await expect(ensureDatabase(id, { ...spec, id }, 'workspace')).rejects.toThrow('could not start');
  state.execFailure = true;
  vi.useFakeTimers();
  const failed = ensureDatabase(id, spec, 'workspace');
  const assertion = expect(failed).rejects.toMatchObject({ statusCode: 503 });
  await vi.runAllTimersAsync();
  await assertion;
  expect(state.volume).toBe(true);
});
it('initializes MongoDB with a project-scoped app role without exposing credentials in commands', async () => {
  const mongo = { ...spec, type: 'mongodb' as const, image: 'mongo:8.0' as const };
  await ensureDatabase(id, mongo, 'workspace');
  const create = state.creates.find((entry) => entry.container).container;
  expect(create.Cmd).toContain('0.25');
  expect(create.HostConfig.Mounts[0].Target).toBe('/data/db');
  expect(state.executions[0].Cmd.join(' ')).toContain('dbOwner');
  expect(state.executions[0].Cmd.join(' ')).not.toContain(spec.adminPassword);
  expect(databaseUrl(id, mongo)).toContain('authSource=repellet');
});
