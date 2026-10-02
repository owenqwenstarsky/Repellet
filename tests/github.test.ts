import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import dotenv from 'dotenv';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
dotenv.config({ quiet: true });
const name = 'repellet_github_' + randomBytes(6).toString('hex');
let app: FastifyInstance,
  fake: FastifyInstance,
  admin: pg.Client,
  database: typeof import('../apps/api/src/db.js'),
  schema: typeof import('../apps/api/src/schema.js'),
  security: typeof import('../apps/api/src/security.js'),
  github: typeof import('../apps/api/src/github.js');
let loginAddress = 10;
let owner: string,
  member: string,
  ownerCookie: string,
  memberCookie: string,
  refreshes = 0,
  revoked = false;
const headers = (cookie: string) => ({
  origin: process.env.PUBLIC_URL || 'http://localhost:3000',
  cookie,
});
const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const config = {
  appId: 123,
  slug: 'repellet-test',
  clientId: 'test-client',
  clientSecret: 'test-client-secret',
  privateKey,
};
describe.skipIf(!process.env.DATABASE_URL)('GitHub App with a local fake GitHub service', () => {
  beforeAll(async () => {
    fake = Fastify();
    fake.all('/*', async (req, reply) => {
      const path = req.url.split('?')[0],
        token = req.headers.authorization?.replace('Bearer ', '');
      if (path === '/login/oauth/access_token') {
        const b = req.body as any;
        if (b.grant_type === 'refresh_token') {
          refreshes++;
          await new Promise((r) => setTimeout(r, 100));
          if (revoked)
            return { error: 'bad_refresh_token', error_description: 'secret-do-not-expose' };
        }
        return {
          access_token: b.code === 'readonly' ? 'read-user' : 'write-user',
          refresh_token: 'refresh-secret',
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
        };
      }
      if (path?.startsWith('/app-manifests/'))
        return {
          id: 123,
          slug: config.slug,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          pem: privateKey,
        };
      if (path === '/app')
        return { id: 123, slug: config.slug, permissions: { contents: 'write', metadata: 'read' } };
      if (revoked) return reply.code(401).send({ message: 'Bad credentials' });
      if (path === '/user')
        return {
          id: token === 'read-user' ? 2 : 1,
          login: token === 'read-user' ? 'reader' : 'writer',
          name: 'Connected GitHub User',
        };
      if (path === '/user/installations')
        return {
          installations: [
            { id: 55, app_id: 123, account: { login: 'test-org' } },
            { id: 66, app_id: 999, account: { login: 'unrelated' } },
          ],
        };
      if (path === '/user/installations/55/repositories')
        return {
          repositories: [
            {
              id: 42,
              full_name: 'test-org/private',
              clone_url: 'https://github.com/test-org/private.git',
              permissions: { pull: true, push: token === 'write-user' },
            },
          ],
        };
      if (path === '/repos/test-org/private/contents')
        return [{ name: 'index.html', type: 'file', size: 0 }];
      if (path === '/repos/test-org/private/contents/index.html')
        return { encoding: 'base64', content: '' };
      return reply.code(404).send({ message: 'Not found' });
    });
    const address = await fake.listen({ host: '127.0.0.1', port: 0 });
    process.env.GITHUB_TEST_API = address;
    process.env.GITHUB_TEST_WEB = address;
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + name;
    process.env.DATABASE_URL = url.href;
    database = await import('../apps/api/src/db.js');
    schema = await import('../apps/api/src/schema.js');
    security = await import('../apps/api/src/security.js');
    github = await import('../apps/api/src/github.js');
    await database.migrate();
    app = await (
      await import('../apps/api/src/app.js')
    ).createApp({ static: false, logger: false });
  });
  beforeEach(async () => {
    await database.pool.query('TRUNCATE users, projects, installation, github_config CASCADE');
    refreshes = 0;
    revoked = false;
    await database.db.insert(schema.installation).values({
      id: 1,
      limits: { cpu: 2, memoryMb: 2048, storageMb: 5120, idleMinutes: 30, maxActiveProjects: 3 },
    });
    const passwordHash = await security.hashPassword('github-test-password-123');
    const [a, b] = await database.db
      .insert(schema.users)
      .values([
        { username: 'owner', displayName: 'Owner', passwordHash, isOwner: true },
        { username: 'member', displayName: 'Member', passwordHash },
      ])
      .returning();
    owner = a!.id;
    member = b!.id;
    const login = async (username: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: `127.0.2.${++loginAddress}`,
        headers: headers(''),
        payload: { username, password: 'github-test-password-123' },
      });
      return `repellet_session=${r.cookies[0]!.value}`;
    };
    ownerCookie = await login('owner');
    memberCookie = await login('member');
    await database.db
      .insert(schema.githubConfig)
      .values({ id: 1, encrypted: security.encrypt(JSON.stringify(config)) });
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await database?.pool.end();
    if (admin) {
      await vi.waitFor(async () => {
        expect(
          Number(
            (await admin.query('SELECT count(*) FROM pg_stat_activity WHERE datname=$1', [name]))
              .rows[0].count,
          ),
        ).toBe(0);
      });
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  });
  async function authorize(cookie: string, code = 'writer') {
    const started = await app.inject({
      method: 'POST',
      url: '/api/github/authorize',
      headers: headers(cookie),
    });
    const state = new URL(started.json().url).searchParams.get('state')!;
    const complete = await app.inject({
      method: 'POST',
      url: '/api/github/complete/authorize',
      headers: headers(cookie),
      payload: { code, state },
    });
    expect(complete.statusCode).toBe(200);
    return state;
  }
  it('restricts configuration to the owner and hides encrypted secrets', async () => {
    expect(
      (await app.inject({ url: '/api/github/config', headers: headers(memberCookie) })).statusCode,
    ).toBe(403);
    const response = await app.inject({ url: '/api/github/config', headers: headers(ownerCookie) });
    expect(response.body).not.toContain('test-client-secret');
    expect(response.body).not.toContain('PRIVATE KEY');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/github/config',
          headers: headers(ownerCookie),
          payload: config,
        })
      ).statusCode,
    ).toBe(200);
    expect((await database.db.select().from(schema.githubConfig))[0]?.encrypted).not.toContain(
      config.clientSecret,
    );
  });
  it('binds single-use authorization state to the initiating account and expires it', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/github/authorize',
      headers: headers(memberCookie),
    });
    const state = new URL(started.json().url).searchParams.get('state')!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/github/complete/authorize',
          headers: headers(ownerCookie),
          payload: { code: 'readonly', state },
        })
      ).statusCode,
    ).toBe(403);
    const success = await app.inject({
      method: 'POST',
      url: '/api/github/complete/authorize',
      headers: headers(memberCookie),
      payload: { code: 'readonly', state },
    });
    expect(success.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/github/complete/authorize',
          headers: headers(memberCookie),
          payload: { code: 'readonly', state },
        })
      ).statusCode,
    ).toBe(403);
    const expired = 'a'.repeat(64);
    await database.db.insert(schema.githubStates).values({
      hash: security.tokenHash(expired),
      userId: member,
      kind: 'authorize',
      expiresAt: new Date(0),
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/github/complete/authorize',
          headers: headers(memberCookie),
          payload: { code: 'readonly', state: expired },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('uses an unauthenticated landing page then authenticated same-origin completion for Strict cookies', async () => {
    const state = 'b'.repeat(64);
    const landing = await app.inject(`/api/github/callback/authorize?code=writer&state=${state}`);
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain("fetch('/api/github/complete/authorize'");
    expect(landing.body).toContain('history.replaceState');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/github/complete/authorize',
          headers: headers(''),
          payload: { code: 'writer', state },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: `127.0.2.${++loginAddress}`,
      headers: headers(''),
      payload: { username: 'owner', password: 'github-test-password-123' },
    });
    expect(login.headers['set-cookie']).toContain('SameSite=Strict');
  });
  it('suggests the bundled static server for an HTML-only GitHub repository', async () => {
    await authorize(ownerCookie);
    const response = await app.inject({
      url: '/api/github/repositories/42/suggestion?installationId=55',
      headers: headers(ownerCookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().runtimes).toEqual(['node']);
    expect(response.json().setupCommand).toBe('');
    expect(response.json().runConfig.command).toContain('static-server.js');
  });
  it('intersects app installations and user access and checks push independently', async () => {
    await authorize(ownerCookie);
    await authorize(memberCookie, 'readonly');
    expect(await github.installationsFor(owner)).toEqual([{ id: 55, account: 'test-org' }]);
    const source = { repositoryId: 42, installationId: 55 };
    expect((await github.validateRepository(owner, source, true)).canPush).toBe(true);
    await expect(github.validateRepository(member, source, true)).rejects.toThrow(
      'push permission',
    );
    await expect(
      github.validateRepository(owner, { ...source, installationId: 66 }),
    ).rejects.toThrow('unavailable');
    await expect(github.validateRepository(owner, { ...source, repositoryId: 99 })).rejects.toThrow(
      'both have access',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/projects',
          headers: headers(ownerCookie),
          payload: {
            name: 'invalid',
            runtimes: ['node'],
            githubSource: { ...source, repositoryId: 99 },
          },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('serializes expiring-token refresh across concurrent calls and persists encrypted rotation', async () => {
    await authorize(ownerCookie);
    await database.db
      .update(schema.githubConnections)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.githubConnections.userId, owner));
    expect(await Promise.all(Array.from({ length: 16 }, () => github.userToken(owner)))).toEqual(
      Array(16).fill('write-user'),
    );
    expect(refreshes).toBe(1);
    const [row] = await database.db.select().from(schema.githubConnections);
    expect(row?.encrypted).not.toContain('refresh-secret');
    expect(row?.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
  it('explains revoked and expired authorization, disconnects locally, and allows reconnect', async () => {
    await authorize(ownerCookie);
    revoked = true;
    await expect(github.repositoriesFor(owner, 55)).rejects.toThrow('GitHub 401');
    await database.db
      .update(schema.githubConnections)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.githubConnections.userId, owner));
    await expect(github.userToken(owner)).rejects.toThrow('Reconnect');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/api/github/connection',
          headers: headers(ownerCookie),
        })
      ).statusCode,
    ).toBe(200);
    await expect(github.userToken(owner)).rejects.toThrow('reconnect');
    revoked = false;
    await authorize(ownerCookie);
    expect(await github.userToken(owner)).toBe('write-user');
  });
});
