import Fastify from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({
  project: {} as any,
  bridge: vi.fn(),
  select: vi.fn(),
}));
vi.mock('../apps/api/src/db.js', () => ({ db: { select: state.select } }));
vi.mock('../apps/api/src/config.js', () => ({ config: {} }));
vi.mock('../apps/api/src/worker.js', () => ({
  bridge: state.bridge,
  workerJson: vi.fn(),
  workerRequest: vi.fn(),
}));
vi.mock('../apps/api/src/security.js', () => ({
  requireUser: async () => ({ id: 'owner' }),
  requireOwner: async () => ({ id: 'owner' }),
  projectAccess: async () => ({ ...state.project, role: 'owner' }),
}));
vi.mock('../apps/api/src/lifecycle.js', () => ({}));
vi.mock('../apps/api/src/processes.js', () => ({}));
vi.mock('../apps/api/src/collaboration.js', () => ({}));
vi.mock('../apps/api/src/live.js', () => ({}));
vi.mock('../apps/api/src/github.js', () => ({}));
vi.mock('../apps/api/src/preparation.js', () => ({
  mainRunProcessIds: async () => new Set(['main', 'run']),
}));

import { routes } from '../apps/api/src/routes.js';
let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  state.project = {
    id: randomUUID(),
    name: 'Project',
    ownerId: 'owner',
    state: 'running',
    appStatus: { status: 'available' },
    environment: 'secret',
    cloneUrl: 'private',
    lastActiveAt: new Date(0),
  };
  state.bridge.mockReset().mockResolvedValue([]);
  state.select.mockReset().mockImplementation((fields: any) => {
    const query: any = {};
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) query[method] = () => query;
    query.orderBy = async () =>
      fields.project
        ? [{ project: state.project, role: null, ownerName: 'Owner' }]
        : [{ ...state.project, ownerName: 'Owner', memberId: null }];
    return query;
  });
  app = Fastify({ logger: false });
  await app.register(routes);
});
afterEach(async () => {
  await app.close();
});

it.each(['list', 'detail', 'admin'])(
  'includes verified main-app activity in the %s response without modifying lifecycle state',
  async (kind) => {
    const url =
      kind === 'detail'
        ? `/api/projects/${state.project.id}`
        : kind === 'admin'
          ? '/api/admin/projects'
          : '/api/projects';
    for (const alive of [true, false]) {
      state.bridge.mockResolvedValue([{ id: 'main', isRun: true, alive }]);
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      const project = kind === 'detail' ? response.json() : response.json()[0];
      expect(project).toMatchObject({ state: 'running', running: alive });
      if (kind !== 'admin') {
        expect(project).not.toHaveProperty('environment');
        expect(project).not.toHaveProperty('cloneUrl');
        expect(project).not.toHaveProperty('lastActiveAt');
      } else expect(project.canOpen).toBe(true);
    }
    expect(state.project.lastActiveAt.getTime()).toBe(0);
    expect(state.bridge).toHaveBeenCalledWith(state.project.id, '/terminals');
  },
);

it('serves idle status when live activity cannot be checked', async () => {
  state.bridge.mockRejectedValue(new Error('Offline'));
  const response = await app.inject({ url: `/api/projects/${state.project.id}` });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ state: 'running', running: false });
});

it('keeps workspace-based Run guards even though the displayed status is Idle', async () => {
  state.project.state = 'stopped';
  const response = await app.inject({
    method: 'POST',
    url: `/api/projects/${state.project.id}/run`,
  });
  expect(response.statusCode).toBe(409);
  expect(state.bridge).not.toHaveBeenCalled();
});
