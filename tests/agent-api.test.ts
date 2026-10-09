import { describe, beforeAll, beforeEach, afterAll, it, expect, vi } from 'vitest';
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { defaultLimits } from '@repellet/shared';
const testState = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../apps/api/src/worker.js', () => ({
  workerJson: vi.fn(async (route: string, _method: string, body: unknown) => {
    testState.calls.push(route);
    return { route, body };
  }),
  bridge: vi.fn(),
  workerRequest: vi.fn(),
}));
vi.mock('../apps/api/src/collaboration.js', () => ({
  flushProject: vi.fn(async () => {
    testState.calls.push('flush');
  }),
  attachDocument: vi.fn(),
  closeDocuments: vi.fn(),
  externalChange: vi.fn(),
}));
const enabled = !!process.env.DATABASE_URL;
const origin = 'http://localhost:3000';
const databaseName = 'repellet_agent_auth_' + randomBytes(5).toString('hex');
let app: FastifyInstance,
  database: typeof import('../apps/api/src/db.js'),
  schema: typeof import('../apps/api/src/schema.js'),
  security: typeof import('../apps/api/src/security.js'),
  admin: pg.Client;
let ownerId: string, projectId: string, siteId: string;
let address = '',
  ownerCookie = '',
  siteCookie = '',
  editorCookie = '',
  viewerCookie = '',
  unrelatedCookie = '';
const upstreamHttp = createServer();
const upstream = new WebSocketServer({ server: upstreamHttp });
const headers = (cookie: string) => ({ cookie, origin });
async function addUser(name: string, siteOwner = false) {
  const [user] = await database.db
    .insert(schema.users)
    .values({ username: name, displayName: name, passwordHash: 'unused', isOwner: siteOwner })
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
  'strict owner-only agent API and WebSocket isolation (PostgreSQL)',
  () => {
    beforeAll(async () => {
      admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = '/' + databaseName;
      process.env.DATABASE_URL = url.toString();
      process.env.PUBLIC_URL = origin;
      await new Promise<void>((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve));
      process.env.WORKER_URL = `http://127.0.0.1:${(upstreamHttp.address() as { port: number }).port}`;
      process.env.ENCRYPTION_KEY ||= '11'.repeat(32);
      process.env.WORKER_TOKEN ||= 'agent-tests-'.repeat(4);
      database = await import('../apps/api/src/db.js');
      schema = await import('../apps/api/src/schema.js');
      security = await import('../apps/api/src/security.js');
      await database.migrate();
      app = await (
        await import('../apps/api/src/app.js')
      ).createApp({ static: false, logger: false });
      address = await app.listen({ host: '127.0.0.1', port: 0 });
      upstream.on('connection', (socket) =>
        socket.send(
          JSON.stringify({
            type: 'snapshot',
            snapshot: {
              generation: randomUUID(),
              sequence: 0,
              transcript: 'private owner transcript',
            },
          }),
        ),
      );
    });
    beforeEach(async () => {
      await database.pool.query('TRUNCATE users,projects,sessions,installation CASCADE');
      await database.db.insert(schema.installation).values({ id: 1, limits: defaultLimits });
      const owner = await addUser('project-owner'),
        site = await addUser('site-admin', true),
        editor = await addUser('editor'),
        viewer = await addUser('viewer'),
        unrelated = await addUser('unrelated');
      ownerId = owner.id;
      ownerCookie = owner.cookie;
      siteId = site.id;
      siteCookie = site.cookie;
      editorCookie = editor.cookie;
      viewerCookie = viewer.cookie;
      unrelatedCookie = unrelated.cookie;
      const [project] = await database.db
        .insert(schema.projects)
        .values({
          ownerId,
          name: 'Private',
          runtimes: ['node'],
          runConfig: { command: '', cwd: '', port: 3000 },
          state: 'running',
        })
        .returning();
      projectId = project!.id;
      await database.db.insert(schema.members).values([
        { projectId, userId: editor.id, role: 'editor' },
        { projectId, userId: viewer.id, role: 'viewer' },
      ]);
      testState.calls = [];
    });
    afterAll(async () => {
      for (const socket of upstream.clients) socket.terminate();
      upstream.close();
      await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
      await app?.close();
      await database?.pool.end();
      if (admin) {
        await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
        await admin.end();
      }
    });
    it('denies editors, viewers, unrelated users, and administrators on another owner’s project', async () => {
      for (const cookie of [editorCookie, viewerCookie, unrelatedCookie, siteCookie]) {
        expect(
          (
            await app.inject({
              url: `/api/projects/${projectId}/agent/status`,
              headers: headers(cookie),
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/projects/${projectId}/agent/rpc`,
              headers: headers(cookie),
              payload: { generation: randomUUID(), method: 'thread/list', params: {} },
            })
          ).statusCode,
        ).toBe(403);
        const socket = new WebSocket(
          `${address.replace(/^http/, 'ws')}/ws/projects/${projectId}/agent`,
          { headers: headers(cookie) },
        );
        const code = await new Promise<number>((resolve, reject) => {
          socket.on('close', resolve);
          socket.on('error', reject);
        });
        expect(code).toBe(1008);
      }
      expect(testState.calls).toHaveLength(0);
    });
    it('routes personal settings exclusively to the signed-in user and requires running workspaces', async () => {
      const result = await app.inject({
        url: `/api/agent/settings?userId=${siteId}`,
        headers: headers(ownerCookie),
      });
      expect(result.json().route).toBe(`/agent/users/${ownerId}/settings`);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/agent/login',
            headers: headers(ownerCookie),
            payload: { userId: siteId },
          })
        ).statusCode,
      ).toBe(400);
      await database.pool.query("UPDATE projects SET state='stopped' WHERE id=$1", [projectId]);
      expect(
        (
          await app.inject({
            url: `/api/projects/${projectId}/agent/status`,
            headers: headers(ownerCookie),
          })
        ).statusCode,
      ).toBe(409);
    });
    it('imports only the signed-in user’s project volumes and rejects supplied project IDs', async () => {
      const result = await app.inject({
        method: 'POST',
        url: '/api/agent/import',
        headers: headers(ownerCookie),
        payload: {},
      });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        route: `/agent/users/${ownerId}/import`,
        body: { projectIds: [projectId] },
      });
      const injection = await app.inject({
        method: 'POST',
        url: '/api/agent/import',
        headers: headers(ownerCookie),
        payload: { projectIds: [siteId] },
      });
      expect(injection.statusCode).toBe(400);
    });
    it('flushes collaborative documents before starting or steering and rejects path/config injection', async () => {
      const params = { threadId: randomUUID(), input: [{ type: 'text', text: 'Make a change' }] };
      const result = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/agent/rpc`,
        headers: headers(ownerCookie),
        payload: { generation: randomUUID(), method: 'turn/start', params },
      });
      expect(result.statusCode).toBe(200);
      expect(testState.calls).toEqual(['flush', `/projects/${projectId}/agent/rpc`]);
      for (const injection of [
        { cwd: '/etc' },
        { sandboxPolicy: { type: 'dangerFullAccess' } },
        { config: {} },
        { history: [] },
      ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/projects/${projectId}/agent/rpc`,
              headers: headers(ownerCookie),
              payload: {
                generation: randomUUID(),
                method: 'turn/start',
                params: { ...params, ...injection },
              },
            })
          ).statusCode,
        ).toBe(400);
    });
    it('exposes only the owner-scoped plan toggle and rejects arbitrary extension commands', async () => {
      const payload = {
        generation: randomUUID(),
        method: 'thread/plan/toggle',
        params: { threadId: randomUUID() },
      };
      const result = await app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/agent/rpc`,
        headers: headers(ownerCookie),
        payload,
      });
      expect(result.statusCode).toBe(200);
      for (const cookie of [viewerCookie, editorCookie])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/api/projects/${projectId}/agent/rpc`,
              headers: headers(cookie),
              payload,
            })
          ).statusCode,
        ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/projects/${projectId}/agent/rpc`,
            headers: headers(ownerCookie),
            payload: { ...payload, params: { ...payload.params, command: '/login' } },
          })
        ).statusCode,
      ).toBe(400);
    });
    it('keeps agent transcripts off ordinary collaboration sockets and revokes owner sockets', async () => {
      const shared = new WebSocket(
        `${address.replace(/^http/, 'ws')}/ws/projects/${projectId}/events`,
        { headers: headers(viewerCookie) },
      );
      const sharedMessages: unknown[] = [];
      shared.on('message', (raw) => sharedMessages.push(JSON.parse(String(raw))));
      await new Promise<void>((resolve, reject) => {
        shared.once('message', () => resolve());
        shared.once('error', reject);
      });
      const privateSocket = new WebSocket(
        `${address.replace(/^http/, 'ws')}/ws/projects/${projectId}/agent`,
        { headers: headers(ownerCookie) },
      );
      const privateMessage = await new Promise<string>((resolve, reject) => {
        privateSocket.once('message', (raw) => resolve(String(raw)));
        privateSocket.once('error', reject);
      });
      expect(privateMessage).toContain('private owner transcript');
      expect(JSON.stringify(sharedMessages)).not.toContain('private owner transcript');
      const closed = new Promise<number>((resolve) => privateSocket.once('close', resolve));
      const disabled = await app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${ownerId}`,
        headers: headers(siteCookie),
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(testState.calls).toContain(`/agent/users/${ownerId}/stop`);
      expect(await closed).toBe(1008);
      expect(
        (await app.inject({ url: '/api/agent/account', headers: headers(ownerCookie) })).statusCode,
      ).toBe(401);
      shared.close();
    });
    it('applies Origin and expired-session checks to agent operations', async () => {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/agent/login',
            headers: { cookie: ownerCookie, origin: 'http://attacker.invalid' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      await database.pool.query(
        "UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
        [ownerId],
      );
      expect(
        (await app.inject({ url: '/api/agent/settings', headers: headers(ownerCookie) }))
          .statusCode,
      ).toBe(401);
    });
  },
);
