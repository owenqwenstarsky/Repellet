import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import pg from 'pg';
import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { defaultLimits } from '@repellet/shared';
dotenv.config({ quiet: true });
const databaseUrl = process.env.DATABASE_URL;
const enabled = !!databaseUrl;
let app: FastifyInstance;
let database: typeof import('../apps/api/src/db.js');
let security: typeof import('../apps/api/src/security.js');
let schema: typeof import('../apps/api/src/schema.js');
let admin: pg.Client;
let address: string;
let ownerCookie = '';
let projectId = '';
let setupAddress = 10;
const testDatabase = 'repellet_test_' + randomBytes(6).toString('hex');
const origin = process.env.PUBLIC_URL || 'http://localhost:3000';
const setupToken = randomBytes(20).toString('hex');
const headers = (cookie = '') => ({ origin, cookie });
const cookieOf = (response: any) =>
  `repellet_session=${response.cookies.find((c: any) => c.name === 'repellet_session').value}`;
async function createUser(username: string) {
  const result = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: headers(ownerCookie),
    payload: { username, displayName: username, password: 'password-for-tests-123' },
  });
  expect(result.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: headers(),
    payload: { username, password: 'password-for-tests-123' },
  });
  return { id: result.json().id, cookie: cookieOf(login) };
}
describe.skipIf(!enabled)('accounts, project permissions, and live revocation (PostgreSQL)', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${testDatabase}`);
    const url = new URL(databaseUrl!);
    url.pathname = '/' + testDatabase;
    process.env.DATABASE_URL = url.toString();
    database = await import('../apps/api/src/db.js');
    security = await import('../apps/api/src/security.js');
    schema = await import('../apps/api/src/schema.js');
    await database.migrate();
    app = await (
      await import('../apps/api/src/app.js')
    ).createApp({ static: false, logger: false });
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  beforeEach(async () => {
    await (await import('../apps/api/src/live.js')).drainWorkspaceEvents();
    await database.pool.query(
      'TRUNCATE users,projects,sessions,documents,jobs,project_members CASCADE',
    );
    await database.pool.query('DELETE FROM installation');
    await database.db
      .insert(schema.installation)
      .values({ id: 1, setupToken: security.encrypt(setupToken), limits: defaultLimits });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: `127.0.0.${++setupAddress}`,
      headers: headers(),
      payload: {
        token: setupToken,
        username: 'owner',
        displayName: 'Owner',
        password: 'password-for-tests-123',
      },
    });
    expect(setup.statusCode).toBe(200);
    ownerCookie = cookieOf(setup);
    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: headers(ownerCookie),
      payload: { name: 'Private project', runtimes: ['node'] },
    });
    expect(project.statusCode).toBe(201);
    projectId = project.json().id;
  });
  afterAll(async () => {
    await app?.close();
    await database?.pool.end();
    if (admin) {
      await vi.waitFor(async () => {
        expect(
          Number(
            (
              await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1', [
                testDatabase,
              ])
            ).rows[0].count,
          ),
        ).toBe(0);
      });
      await admin.query(`DROP DATABASE ${testDatabase}`);
      await admin.end();
    }
  });
  it('allows owner setup only once and has no registration route', async () => {
    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: headers(),
      payload: {
        token: setupToken,
        username: 'otherowner',
        displayName: 'Other',
        password: 'password-for-tests-123',
      },
    });
    expect(again.statusCode).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: '/api/register', headers: headers(), payload: {} }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject('/api/setup/status')).json().required).toBe(false);
  });
  it('serializes simultaneous first-owner setup requests', async () => {
    await database.pool.query(
      'TRUNCATE users,projects,sessions,documents,jobs,project_members CASCADE',
    );
    await database.db.update(schema.installation).set({ setupToken: security.encrypt(setupToken) });
    const requests = await Promise.all(
      ['first', 'second'].map((username) =>
        app.inject({
          method: 'POST',
          url: '/api/setup',
          remoteAddress: `127.0.1.${++setupAddress}`,
          headers: headers(),
          payload: {
            token: setupToken,
            username,
            displayName: username,
            password: 'password-for-tests-123',
          },
        }),
      ),
    );
    expect(requests.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await database.pool.query('SELECT count(*)::int AS count FROM users WHERE is_owner=true'))
        .rows[0].count,
    ).toBe(1);
  });
  it('requires an exact allowed origin for state changes', async () => {
    for (const requestHeaders of [
      { cookie: ownerCookie },
      { cookie: ownerCookie, origin: 'http://attacker.invalid' },
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/projects',
            headers: requestHeaders,
            payload: { name: 'bad', runtimes: ['node'] },
          })
        ).statusCode,
      ).toBe(403);
  });
  it('keeps projects private and forbids viewer mutations', async () => {
    const viewer = await createUser('viewer');
    expect(
      (await app.inject({ url: `/api/projects/${projectId}`, headers: headers(viewer.cookie) }))
        .statusCode,
    ).toBe(404);
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/members`,
      headers: headers(ownerCookie),
      payload: { userId: viewer.id, role: 'viewer' },
    });
    for (const endpoint of ['files/create', 'files/delete', 'run', 'terminals', 'git', 'stop'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/projects/${projectId}/${endpoint}`,
            headers: headers(viewer.cookie),
            payload: { path: 'test', kind: 'file', action: 'init' },
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/projects/${projectId}/environment`,
          headers: headers(viewer.cookie),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({ url: `/api/projects/${projectId}`, headers: headers(viewer.cookie) })
      ).json().role,
    ).toBe('viewer');
  });
  it('revokes disabled accounts and already-open WebSockets', async () => {
    const editor = await createUser('editor');
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/members`,
      headers: headers(ownerCookie),
      payload: { userId: editor.id, role: 'editor' },
    });
    const ws = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/projects/${projectId}/events`, {
      headers: headers(editor.cookie),
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve());
      ws.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${editor.id}`,
      headers: headers(ownerCookie),
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(await closed).toBe(1008);
    expect(
      (await app.inject({ url: '/api/auth/me', headers: headers(editor.cookie) })).statusCode,
    ).toBe(401);
  });
  it('removes access when a project membership is removed', async () => {
    const editor = await createUser('editor');
    await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/members`,
      headers: headers(ownerCookie),
      payload: { userId: editor.id, role: 'editor' },
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/projects/${projectId}/members/${editor.id}`,
      headers: headers(ownerCookie),
    });
    expect(
      (await app.inject({ url: `/api/projects/${projectId}`, headers: headers(editor.cookie) }))
        .statusCode,
    ).toBe(404);
  });
  it('encrypts project variables and does not include them in project responses', async () => {
    const result = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/environment`,
      headers: headers(ownerCookie),
      payload: { runtimes: ['node'], variables: { API_SECRET: 'private-value' } },
    });
    expect(result.statusCode).toBe(200);
    const row = await database.pool.query('SELECT environment FROM projects WHERE id=$1', [
      projectId,
    ]);
    expect(row.rows[0].environment).not.toContain('private-value');
    expect(security.decrypt(row.rows[0].environment)).toContain('private-value');
    expect(
      (await app.inject({ url: `/api/projects/${projectId}`, headers: headers(ownerCookie) })).body,
    ).not.toContain('private-value');
  });
});
