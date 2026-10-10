import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { projects, projectRunProfiles, workspaceProcesses } from '../apps/api/src/schema.js';

const state = vi.hoisted(() => ({ records: [] as any[], spawned: false }));
vi.mock('../apps/api/src/db.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === projects) return [{ state: 'running', storageExceeded: false }];
          if (table === projectRunProfiles)
            return [
              { id: 'profile', isDefault: true, name: 'App', command: 'node app.js', cwd: '' },
            ];
          if (table === workspaceProcesses) return state.records;
          throw new Error('Unexpected table');
        },
      }),
    }),
    insert: () => ({
      values: (record: any) => ({
        returning: async () => {
          const saved = { ...record, id: 'process', createdAt: new Date() };
          state.records.push(saved);
          return [saved];
        },
      }),
    }),
    update: () => ({
      set: (values: any) => ({ where: async () => Object.assign(state.records[0]!, values) }),
    }),
    execute: vi.fn(),
  },
}));
vi.mock('../apps/api/src/worker.js', () => ({ bridge: vi.fn() }));
vi.mock('../apps/api/src/collaboration.js', () => ({ flushProject: vi.fn() }));
vi.mock('../apps/api/src/preparation.js', () => ({ assertPrepared: vi.fn() }));
vi.mock('../apps/api/src/live.js', () => ({ emit: vi.fn() }));

import { startProfile } from '../apps/api/src/processes.js';
import { bridge } from '../apps/api/src/worker.js';
import { flushProject } from '../apps/api/src/collaboration.js';
import { emit } from '../apps/api/src/live.js';

beforeEach(() => {
  vi.resetAllMocks();
  state.records = [];
  state.spawned = false;
  vi.mocked(bridge).mockImplementation(async (_projectId, path, method) => {
    if (path === '/health') return { protocolVersion: 1, capabilities: ['processes'] };
    if (path === '/processes' && method === 'POST') {
      state.spawned = true;
      throw new Error('lost spawn response');
    }
    if (path === '/processes') return [];
    if (path === '/run/stop') return { ok: true };
    throw new Error('Unexpected route');
  });
});

it('does not perform any bridge operation for an already aborted start', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    startProfile(randomUUID(), 'profile', undefined, 'run', controller.signal),
  ).rejects.toThrow();
  expect(bridge).not.toHaveBeenCalled();
  expect(state.records).toEqual([]);
});

it('cancels before creating a process record when flushing is interrupted', async () => {
  const controller = new AbortController();
  vi.mocked(flushProject).mockImplementation(async () => {
    controller.abort();
  });
  await expect(
    startProfile('project', 'profile', undefined, 'run', controller.signal),
  ).rejects.toThrow();
  expect(state.records).toEqual([]);
  expect(state.spawned).toBe(false);
});

it('marks a known unspawned record failed rather than leaving an unresolved start after cancellation', async () => {
  const controller = new AbortController();
  vi.mocked(emit).mockImplementation(async (_id, event: any) => {
    if (event.process?.status === 'starting') controller.abort();
  });
  await expect(
    startProfile('project', 'profile', undefined, 'run', controller.signal),
  ).rejects.toThrow();
  expect(state.spawned).toBe(false);
  expect(state.records[0]).toMatchObject({ status: 'failed', finishedAt: expect.any(Date) });
});

it('keeps an uncertain dispatched start pending without replaying the bridge spawn', async () => {
  await expect(startProfile('project', 'profile')).rejects.toThrow('lost spawn response');
  expect(state.records[0]).toMatchObject({ status: 'starting' });
  expect(
    vi
      .mocked(bridge)
      .mock.calls.filter(([, path, method]) => path === '/processes' && method === 'POST'),
  ).toHaveLength(1);
});
