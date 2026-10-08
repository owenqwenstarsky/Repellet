import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { defaultLimits } from '@repellet/shared';
const fake = vi.hoisted(() => ({ processes: [] as any[], calls: [] as string[] }));
vi.mock('../apps/api/src/worker.js', () => ({
  workerJson: vi.fn(async (route: string) => {
    fake.calls.push(route);
    return {};
  }),
  workerRequest: vi.fn(),
  bridge: vi.fn(async (_id: string, route: string, method: string, body: any) => {
    fake.calls.push(route);
    if (route === '/health') return { protocolVersion: 1, capabilities: ['processes'] };
    if (route === '/processes' && method === 'POST') {
      const process = { ...body, pid: 123, startedAt: new Date().toISOString(), status: 'running' };
      fake.processes.push(process);
      return process;
    }
    if (route === '/processes') return fake.processes;
    if (route.startsWith('/terminals/') && method === 'DELETE') {
      const process = fake.processes.find((p) => p.id === route.split('/')[2]);
      if (process)
        Object.assign(process, {
          status: 'stopped',
          finishedAt: new Date().toISOString(),
          exitCode: 0,
        });
    }
    return {};
  }),
}));
vi.mock('../apps/api/src/collaboration.js', () => ({
  flushProject: vi.fn(async () => {
    fake.calls.push('flush');
  }),
  closeDocuments: vi.fn(),
  attachDocument: vi.fn(),
  externalChange: vi.fn(),
}));
const enabled = !!process.env.DATABASE_URL;
const name = 'repellet_workspace_' + randomBytes(5).toString('hex');
let app: FastifyInstance,
  admin: pg.Client,
  database: typeof import('../apps/api/src/db.js'),
  schema: typeof import('../apps/api/src/schema.js'),
  security: typeof import('../apps/api/src/security.js'),
  journal: typeof import('../apps/api/src/workspaceEvents.js'),
  live: typeof import('../apps/api/src/live.js');
let projectId: string,
  owner: { id: string; cookie: string },
  editor: { id: string; cookie: string },
  viewer: { id: string; cookie: string },
  site: { id: string; cookie: string },
  address: string;
const sockets: WebSocket[] = [];
const headers = (cookie: string) => ({ cookie, origin: 'http://localhost:3000' });
async function addUser(username: string, isOwner = false) {
  const [user] = await database.db
    .insert(schema.users)
    .values({ username, displayName: username, passwordHash: 'unused', isOwner })
    .returning();
  const token = randomBytes(32).toString('hex');
  await database.db.insert(schema.sessions).values({
    userId: user!.id,
    tokenHash: security.tokenHash(token),
    expiresAt: new Date(Date.now() + 3600000),
  });
  return { id: user!.id, cookie: `repellet_session=${token}` };
}
describe.skipIf(!enabled)(
  'workspace persistence, permissions, replay and processes (PostgreSQL)',
  () => {
    beforeAll(async () => {
      admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = '/' + name;
      process.env.DATABASE_URL = url.toString();
      process.env.ENCRYPTION_KEY ||= '11'.repeat(32);
      process.env.WORKER_TOKEN ||= 'test-worker-token-'.repeat(4);
      process.env.PUBLIC_URL = 'http://localhost:3000';
      database = await import('../apps/api/src/db.js');
      schema = await import('../apps/api/src/schema.js');
      security = await import('../apps/api/src/security.js');
      journal = await import('../apps/api/src/workspaceEvents.js');
      live = await import('../apps/api/src/live.js');
      await database.migrate();
      app = await (
        await import('../apps/api/src/app.js')
      ).createApp({ static: false, logger: false });
      address = await app.listen({ port: 0, host: '127.0.0.1' });
    });
    beforeEach(async () => {
      await live.drainWorkspaceEvents();
      await database.pool.query('TRUNCATE users,projects,installation CASCADE');
      await database.db.insert(schema.installation).values({ id: 1, limits: defaultLimits });
      owner = await addUser('owner');
      editor = await addUser('editor');
      viewer = await addUser('viewer');
      site = await addUser('site', true);
      const [project] = await database.db
        .insert(schema.projects)
        .values({
          ownerId: owner.id,
          name: 'Private',
          state: 'running',
          runtimes: ['node'],
          runConfig: { command: 'npm start', cwd: 'web', port: 3000 },
        })
        .returning();
      projectId = project!.id;
      await database.db.insert(schema.members).values([
        { projectId, userId: editor.id, role: 'editor' },
        { projectId, userId: viewer.id, role: 'viewer' },
      ]);
      fake.calls = [];
      fake.processes = [];
    });
    afterEach(async () => {
      for (const socket of sockets.splice(0)) {
        if (socket.readyState !== 3)
          await new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.close();
          });
      }
      await vi.waitFor(() => expect(live.workspaceConnectionCount(projectId)).toBe(0));
      await live.drainWorkspaceEvents();
    });
    afterAll(async () => {
      await app?.close();
      await database?.pool.end();
      if (admin) {
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.end();
      }
    });
    it('projects existing and newly updated Run settings into one default profile', async () => {
      let result = await app.inject({
        url: `/api/projects/${projectId}/run-profiles`,
        headers: headers(owner.cookie),
      });
      expect(result.json()).toMatchObject([
        { name: 'Run', command: 'npm start', cwd: 'web', isDefault: true },
      ]);
      const id = result.json()[0].id;
      await database.pool.query('UPDATE projects SET run_config=$1 WHERE id=$2', [
        JSON.stringify({ command: 'python app.py', cwd: 'server', port: 8000 }),
        projectId,
      ]);
      result = await app.inject({
        url: `/api/projects/${projectId}/run-profiles`,
        headers: headers(owner.cookie),
      });
      expect(result.json()).toMatchObject([{ id, command: 'python app.py', cwd: 'server' }]);
      const profiles = await database.pool.query(
        'SELECT * FROM project_preview_targets WHERE project_id=$1',
        [projectId],
      );
      expect(profiles.rows).toMatchObject([{ target_port: 8000 }]);
    });
    it('denies site administrators project contents but retains operational inventory', async () => {
      for (const endpoint of [
        '',
        '/environment',
        '/workspace',
        '/activity',
        '/run-profiles',
        '/processes',
      ])
        expect(
          (
            await app.inject({
              url: `/api/projects/${projectId}${endpoint}`,
              headers: headers(site.cookie),
            })
          ).statusCode,
        ).toBe(404);
      const inventory = await app.inject({
        url: '/api/admin/projects',
        headers: headers(site.cookie),
      });
      expect(inventory.json()[0]).toMatchObject({ id: projectId, canOpen: false });
      for (const field of ['runConfig', 'environment', 'repository', 'role', 'setupCommand'])
        expect(inventory.json()[0]).not.toHaveProperty(field);
      await database.db
        .insert(schema.members)
        .values({ projectId, userId: site.id, role: 'viewer' });
      expect(
        (
          await app.inject({ url: `/api/projects/${projectId}`, headers: headers(site.cookie) })
        ).json().role,
      ).toBe('viewer');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/projects/${projectId}/stop`,
            headers: headers(site.cookie),
          })
        ).statusCode,
      ).toBe(403);
    });
    it('sequences concurrent durable events and replays through a new connection', async () => {
      const records = await Promise.all(
        Array.from({ length: 12 }, (_, n) =>
          journal.appendWorkspaceEvent({
            projectId,
            type: 'file',
            payload: { type: 'file', path: `${n}.ts` },
          }),
        ),
      );
      expect(records.map((r) => r.seq).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, n) => n + 1),
      );
      const received: any[] = [];
      const socket = new WebSocket(
        `${address.replace('http:', 'ws:')}/ws/projects/${projectId}/events?protocol=1&cursor=8`,
        { headers: headers(viewer.cookie) },
      );
      sockets.push(socket);
      socket.on('message', (raw) => received.push(JSON.parse(String(raw))));
      await vi.waitFor(() => expect(received.some((m) => m.type === 'ready')).toBe(true));
      expect(
        received
          .filter((m) => m.type === 'event')
          .slice(0, 4)
          .map((m) => m.event.seq),
      ).toEqual([9, 10, 11, 12]);
      await live.emit(projectId, { type: 'structure', from: 'old', to: 'new' });
      await vi.waitFor(() =>
        expect(received.some((m) => m.event?.payload?.from === 'old')).toBe(true),
      );
      const events = received.filter((m) => m.type === 'event').map((m) => m.event.seq);
      expect(new Set(events).size).toBe(events.length);
      expect(events).toEqual([...events].sort((a, b) => a - b));
    });
    it('compacts event rows and explicitly requests resync for expired and future cursors', async () => {
      await journal.appendWorkspaceEvent({ projectId, type: 'project', payload: {} });
      await database.pool.query('UPDATE workspace_streams SET seq=2000 WHERE project_id=$1', [
        projectId,
      ]);
      await journal.appendWorkspaceEvent({ projectId, type: 'project', payload: {} });
      expect(await journal.replayWorkspaceEvents(projectId, 0)).toMatchObject({
        kind: 'resync',
        reason: 'expired',
        cursor: 2001,
      });
      expect(await journal.replayWorkspaceEvents(projectId, 3000)).toMatchObject({
        kind: 'resync',
        reason: 'ahead',
      });
      expect(
        (
          await database.pool.query(
            'SELECT count(*)::int AS n FROM workspace_events WHERE project_id=$1',
            [projectId],
          )
        ).rows[0].n,
      ).toBe(1);
    });
    it('persists independent process IDs, flushes documents, and reconciles lost processes', async () => {
      const create = (name: string) =>
        app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/run-profiles`,
          headers: headers(owner.cookie),
          payload: {
            name,
            command: 'npm start',
            cwd: '',
            environmentKeys: ['PUBLIC_VALUE'],
            autoStart: false,
          },
        });
      const first = (await create('Frontend')).json(),
        second = (await create('API')).json();
      const start = (id: string, cookie = editor.cookie) =>
        app.inject({
          method: 'POST',
          url: `/api/projects/${projectId}/run-profiles/${id}/start`,
          headers: headers(cookie),
          payload: {},
        });
      expect((await start(first.id, viewer.cookie)).statusCode).toBe(403);
      const a = await start(first.id),
        b = await start(second.id);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(a.json().id).not.toBe(b.json().id);
      expect(fake.processes).toHaveLength(2);
      expect(fake.calls.indexOf('flush')).toBeLessThan(
        fake.calls.indexOf('/processes', fake.calls.indexOf('flush')),
      );
      expect((await start(first.id)).json().id).toBe(a.json().id);
      expect(fake.processes).toHaveLength(2);
      fake.processes = [];
      const recovered = await app.inject({
        url: `/api/projects/${projectId}/processes`,
        headers: headers(viewer.cookie),
      });
      expect(recovered.json().map((p: any) => p.status)).toEqual(['failed', 'failed']);
    });
    it('replays lifecycle receipts and refuses idempotency-key reuse with changed input', async () => {
      const request = {
        method: 'POST' as const,
        url: `/api/projects/${projectId}/stop`,
        headers: { ...headers(owner.cookie), 'idempotency-key': randomUUID() },
        payload: {},
      };
      const first = await app.inject(request);
      expect(first.statusCode).toBe(200);
      const again = await app.inject(request);
      expect(again.statusCode).toBe(200);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(fake.calls.filter((route) => route === `/projects/${projectId}/stop`)).toHaveLength(1);
      expect((await app.inject({ ...request, payload: { changed: true } })).statusCode).toBe(409);
    });
  },
);
