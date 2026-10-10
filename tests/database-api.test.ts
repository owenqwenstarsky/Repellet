import Fastify from 'fastify';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceQueue } from '../apps/api/src/workspaceQueue.js';
const state = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  role: 'owner',
  enabled: true,
  syncFailure: false,
}));
vi.mock('../apps/api/src/db.js', () => {
  const name = (table: any) => table[Symbol.for('drizzle:Name')] as string;
  const database: any = {
    select: () => ({
      from: (table: any) => ({ where: async () => state.tables[name(table)] || [] }),
    }),
    insert: (table: any) => ({
      values: (values: any) => ({
        returning: async () => {
          const tableName = name(table);
          if (tableName === 'project_databases' && state.tables[tableName]?.length)
            throw Object.assign(new Error('duplicate'), { code: '23505' });
          const record = { initialized: false, error: null, createdAt: new Date(), ...values };
          (state.tables[tableName] ||= []).push(record);
          return [record];
        },
      }),
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: async () => {
          for (const record of state.tables[name(table)] || [])
            for (const [key, value] of Object.entries(patch))
              record[key] =
                key === 'environmentRevision' && typeof value !== 'number'
                  ? record[key] + 1
                  : value;
        },
      }),
    }),
    delete: (table: any) => ({
      where: async () => {
        state.tables[name(table)] = [];
      },
    }),
    transaction: async (fn: any) => {
      const snapshot = structuredClone(state.tables);
      try {
        return await fn(database);
      } catch (error) {
        state.tables = snapshot;
        throw error;
      }
    },
  };
  return { db: database };
});
vi.mock('../apps/api/src/lifecycle.js', async () => {
  const { WorkspaceQueue } = await import('../apps/api/src/workspaceQueue.js');
  const queue = new WorkspaceQueue();
  return { serialize: (id: string, fn: any) => queue.run(id, fn) };
});
vi.mock('../apps/api/src/config.js', () => ({ config: { workerToken: 'worker-secret' } }));
vi.mock('../apps/api/src/security.js', () => ({
  encrypt: (value: string) => 'sealed:' + value,
  decrypt: (value: string) => value.slice(7),
  requireUser: async () => ({ id: '22222222-2222-4222-8222-222222222222' }),
  projectAccess: async (_user: any, _id: string, mode: string) => {
    if (state.role === 'viewer' || (mode === 'manage' && state.role !== 'owner'))
      throw Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });
    return state.tables.projects[0];
  },
  projectAgentAccess: async () => {
    if (!state.enabled || state.role !== 'owner')
      throw Object.assign(new Error('Denied'), { statusCode: 403 });
    return state.tables.projects[0];
  },
  tokenMatches: (given: string, expected: string) => given === expected,
}));
vi.mock('../apps/api/src/live.js', () => ({ emit: vi.fn(async () => {}) }));
vi.mock('../apps/api/src/worker.js', () => ({ workerJson: vi.fn(), bridge: vi.fn() }));
import {
  createDatabase,
  deleteDatabase,
  databaseStatus,
  operateDatabase,
  retryDatabaseWithinOperation,
} from '../apps/api/src/databases.js';
import {
  environmentSnapshot,
  changeEnvironment,
  saveEnvironment,
} from '../apps/api/src/environment.js';
import { workerJson, bridge } from '../apps/api/src/worker.js';
import { resourceControl, resourceControlRoutes } from '../apps/api/src/resourceControl.js';
import { databaseRoutes } from '../apps/api/src/databaseRoutes.js';
const id = '11111111-1111-4111-8111-111111111111',
  userId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  state.role = 'owner';
  state.enabled = true;
  state.syncFailure = false;
  state.tables = {
    projects: [
      {
        id,
        state: 'running',
        runtimes: ['node'],
        environment: 'sealed:{}',
        environmentRevision: 0,
        storageExceeded: false,
      },
    ],
    project_databases: [],
    project_run_profiles: [{ id: 'profile', environmentKeys: ['DATABASE_URL', 'TOKEN'] }],
    users: [{ id: userId }],
    installation: [{ maintenance: false }],
  };
  vi.mocked(workerJson).mockReset().mockResolvedValue({ status: 'ready' });
  vi.mocked(bridge)
    .mockReset()
    .mockImplementation(async (_id, path) => {
      if (path === '/health') return { capabilities: ['database'] };
      if (path === '/environment' && state.syncFailure) throw new Error('offline');
      return path === '/database' ? { rows: [{ id: 'one' }] } : { ok: true };
    });
});
it('admits only one simultaneous creation and persists credentials/managed URL together', async () => {
  const results = await Promise.allSettled([
    createDatabase(id, 'postgresql'),
    createDatabase(id, 'mongodb'),
  ]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(workerJson).toHaveBeenCalledTimes(1);
  const environment = await environmentSnapshot(id);
  expect(environment.variables.DATABASE_URL).toMatch(
    /^postgresql:\/\/workspace:[a-f0-9]{64}@repellet-database-/,
  );
  expect(state.tables.project_databases[0].initialized).toBe(true);
  const status = await databaseStatus(id);
  expect(status).toMatchObject({
    type: 'postgresql',
    variableName: 'DATABASE_URL',
    status: 'ready',
  });
  expect(status).not.toHaveProperty('credentials');
  expect(status).not.toHaveProperty('initialized');
});
it('preserves an existing DATABASE_URL and records recoverable provisioning failures', async () => {
  state.tables.projects[0].environment = 'sealed:{"DATABASE_URL":"existing"}';
  await expect(createDatabase(id, 'postgresql')).rejects.toThrow('Rename or remove');
  expect(workerJson).not.toHaveBeenCalled();
  state.tables.projects[0].environment = 'sealed:{}';
  vi.mocked(workerJson).mockRejectedValueOnce(new Error('private Docker credentials'));
  expect(await createDatabase(id, 'mongodb')).toMatchObject({ status: 'failed' });
  expect((await environmentSnapshot(id)).variables.DATABASE_URL).toContain('mongodb://');
  expect(JSON.stringify(await databaseStatus(id))).not.toContain('private Docker');
  await retryDatabaseWithinOperation(id);
  expect(await databaseStatus(id)).toMatchObject({ status: 'ready' });
});
it('protects the variable through incremental and whole-environment APIs and renames profiles', async () => {
  await createDatabase(id, 'postgresql');
  const initial = await environmentSnapshot(id);
  await expect(
    changeEnvironment(id, { operation: 'delete', name: 'DATABASE_URL' }),
  ).rejects.toThrow('managed');
  await expect(saveEnvironment(id, { variables: {}, revision: initial.revision })).rejects.toThrow(
    'cannot be edited',
  );
  await expect(
    saveEnvironment(id, { variables: { DATABASE_URL: 'other' }, revision: initial.revision }),
  ).rejects.toThrow();
  await changeEnvironment(id, { operation: 'rename', name: 'DATABASE_URL', newName: 'DB' });
  expect(await databaseStatus(id)).toMatchObject({ variableName: 'DB' });
  expect((await environmentSnapshot(id)).variables).toEqual({ DB: initial.variables.DATABASE_URL });
  expect(state.tables.project_run_profiles[0].environmentKeys).toEqual(['DB', 'TOKEN']);
  await expect(
    saveEnvironment(id, { variables: initial.variables, revision: initial.revision }),
  ).rejects.toThrow('Reload');
  await changeEnvironment(id, { operation: 'create', name: 'TOKEN', value: 'secret' });
  await changeEnvironment(id, { operation: 'rename', name: 'TOKEN', newName: 'API_TOKEN' });
  expect(state.tables.project_run_profiles[0].environmentKeys).toEqual(['DB', 'API_TOKEN']);
});
it('holds failed deletions until retry and removes the renamed variable before replacement', async () => {
  await createDatabase(id, 'postgresql');
  await changeEnvironment(id, { operation: 'rename', name: 'DATABASE_URL', newName: 'DB' });
  vi.mocked(workerJson).mockRejectedValueOnce(new Error('volume busy'));
  await expect(deleteDatabase(id)).rejects.toThrow('incomplete');
  expect(await databaseStatus(id)).toMatchObject({ status: 'deleting', variableName: 'DB' });
  expect((await environmentSnapshot(id)).variables).toHaveProperty('DB');
  await expect(createDatabase(id, 'mongodb')).rejects.toThrow('already has');
  await deleteDatabase(id);
  expect(await databaseStatus(id)).toBeNull();
  expect((await environmentSnapshot(id)).variables).not.toHaveProperty('DB');
  await createDatabase(id, 'mongodb');
  expect((await environmentSnapshot(id)).variables.DATABASE_URL).toContain('mongodb://');
});
it('saves canonical values across bridge-sync failures and distinguishes missing capabilities', async () => {
  state.syncFailure = true;
  expect(
    await changeEnvironment(id, { operation: 'create', name: 'TOKEN', value: 'secret' }),
  ).toMatchObject({ synced: false });
  expect((await environmentSnapshot(id)).variables.TOKEN).toBe('secret');
  state.syncFailure = false;
  await createDatabase(id, 'postgresql');
  vi.mocked(bridge).mockResolvedValueOnce({ capabilities: [] });
  await expect(operateDatabase(id, { operation: 'schema' })).rejects.toThrow('Stop and start');
  const controller = new AbortController();
  controller.abort();
  await expect(operateDatabase(id, { operation: 'schema' }, controller.signal)).rejects.toThrow();
});
it('applies owner/editor/viewer permissions and protects the worker-authenticated agent endpoint', async () => {
  const app = Fastify();
  app.setErrorHandler((error: any, _req, reply) =>
    reply.code(error.statusCode || 400).send({ error: error.message }),
  );
  await databaseRoutes(app);
  await resourceControlRoutes(app);
  try {
    state.role = 'editor';
    expect(
      (await app.inject({ method: 'GET', url: `/api/projects/${id}/database` })).statusCode,
    ).toBe(200);
    for (const request of [
      { method: 'POST', url: `/api/projects/${id}/database`, payload: { type: 'postgresql' } },
      { method: 'DELETE', url: `/api/projects/${id}/database` },
      {
        method: 'POST',
        url: `/api/projects/${id}/environment/variables`,
        payload: { operation: 'create', name: 'A', value: 'x' },
      },
    ])
      expect((await app.inject(request as any)).statusCode).toBe(403);
    state.role = 'viewer';
    expect(
      (await app.inject({ method: 'GET', url: `/api/projects/${id}/database` })).statusCode,
    ).toBe(403);
    state.role = 'owner';
    const payload = {
      projectId: id,
      userId,
      control: { operation: 'database_status', arguments: {} },
    };
    expect(
      (await app.inject({ method: 'POST', url: '/internal/agent/resource-control', payload }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/internal/agent/resource-control',
          headers: { authorization: 'Bearer worker-secret' },
          payload,
        })
      ).json(),
    ).toEqual({ data: null });
    state.enabled = false;
    expect(await resourceControl(id, userId, payload.control)).toMatchObject({
      error: { code: 'access_denied' },
    });
  } finally {
    await app.close();
  }
});
it('returns only names unless a value is requested, and blocks agent mutations during maintenance', async () => {
  await changeEnvironment(id, { operation: 'create', name: 'TOKEN', value: 'private-value' });
  expect(
    await resourceControl(id, userId, { operation: 'environment_list', arguments: {} }),
  ).toEqual({ data: { names: ['TOKEN'], databaseVariableName: null } });
  expect(
    await resourceControl(id, userId, {
      operation: 'environment_get',
      arguments: { name: 'TOKEN' },
    }),
  ).toMatchObject({ data: { value: 'private-value' } });
  state.tables.installation[0].maintenance = true;
  expect(
    await resourceControl(id, userId, {
      operation: 'environment_delete',
      arguments: { name: 'TOKEN' },
    }),
  ).toMatchObject({ error: { code: 'maintenance' } });
  expect((await environmentSnapshot(id)).variables).toHaveProperty('TOKEN');
});
