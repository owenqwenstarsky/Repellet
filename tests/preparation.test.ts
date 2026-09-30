import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import pg from 'pg';
import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { defaultLimits } from '@repellet/shared';
import type { FastifyInstance } from 'fastify';
dotenv.config({ quiet: true });
const fake = vi.hoisted(() => ({ bridge: vi.fn(), workerJson: vi.fn(), flushProject: vi.fn() }));
vi.mock('../apps/api/src/worker.js', () => fake);
vi.mock('../apps/api/src/collaboration.js', async (original) => ({
  ...(await original<typeof import('../apps/api/src/collaboration.js')>()),
  flushProject: fake.flushProject,
}));
const name = 'repellet_prepare_' + randomBytes(6).toString('hex');
let admin: pg.Client,
  app: FastifyInstance,
  db: typeof import('../apps/api/src/db.js'),
  schema: typeof import('../apps/api/src/schema.js'),
  preparation: typeof import('../apps/api/src/preparation.js');
let id: string,
  fingerprint = 'dependencies-v1',
  status = 'succeeded',
  scaffoldCalls = 0,
  installCalls = 0;
describe.skipIf(!process.env.DATABASE_URL)('durable preparation and readiness', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + name;
    process.env.DATABASE_URL = url.href;
    db = await import('../apps/api/src/db.js');
    schema = await import('../apps/api/src/schema.js');
    await db.migrate();
    preparation = await import('../apps/api/src/preparation.js');
    app = await (
      await import('../apps/api/src/app.js')
    ).createApp({ static: false, logger: false });
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE users, projects, installation CASCADE');
    const [user] = await db.db
      .insert(schema.users)
      .values({ username: 'owner', displayName: 'Owner', passwordHash: 'unused' })
      .returning();
    const [project] = await db.db
      .insert(schema.projects)
      .values({
        ownerId: user!.id,
        name: 'Starter',
        runtimes: ['node'],
        state: 'running',
        starterId: 'react-vite',
        starterVersion: 1,
        setupCommand: 'npm ci',
        runConfig: { command: 'npm run dev', cwd: '', port: 3000 },
        preparation: { status: 'pending', scaffolded: false, fingerprint: null, error: null },
      })
      .returning();
    id = project!.id;
    fingerprint = 'dependencies-v1';
    status = 'succeeded';
    scaffoldCalls = 0;
    installCalls = 0;
    fake.bridge.mockReset();
    fake.workerJson.mockReset();
    fake.flushProject.mockReset().mockResolvedValue(undefined);
    fake.bridge.mockImplementation(async (_id: string, path: string) => {
      if (path === '/scaffold') {
        scaffoldCalls++;
        return { ok: true };
      }
      if (path === '/fingerprint') return { fingerprint };
      if (path === '/preparation') {
        installCalls++;
        return { state: 'running' };
      }
      if (path === '/preparation/cancel') {
        status = 'cancelled';
        return { ok: true };
      }
      if (path.startsWith('/preparation/'))
        return {
          state: status,
          exitCode: status === 'succeeded' ? 0 : 1,
          log: 'installation log\n' + 'x'.repeat(70000),
        };
      return { ok: true };
    });
  });
  afterAll(async () => {
    vi.useRealTimers();
    await app?.close();
    await db?.pool.end();
    if (admin) {
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  });
  const project = async () =>
    (await db.db.select().from(schema.projects).where(eq(schema.projects.id, id)))[0]!;
  it('flushes accepted editor changes before inspecting repository manifests', async () => {
    const { tokenHash } = await import('../apps/api/src/security.js');
    await db.db.insert(schema.sessions).values({
      userId: (await project()).ownerId,
      tokenHash: tokenHash('setup-inspection-session'),
      expiresAt: new Date(Date.now() + 60000),
    });
    let flushed = false;
    fake.flushProject.mockImplementation(async () => {
      flushed = true;
    });
    fake.bridge.mockImplementation(async (_id: string, path: string) => {
      if (path === '/inspect')
        return {
          files: {
            'package.json': JSON.stringify({
              scripts: flushed ? { start: 'node server.js' } : { dev: 'vite' },
            }),
          },
        };
      return {};
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/setup/suggest`,
      headers: {
        origin: process.env.PUBLIC_URL || 'http://localhost:3000',
        cookie: 'repellet_session=setup-inspection-session',
      },
      payload: { cwd: '' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().runConfig.command).toBe('npm run start');
  });
  it('scaffolds once, bounds logs, records duration, and reuses unchanged installation', async () => {
    await preparation.prepareProject(id);
    expect((await project()).preparation.status).toBe('ready');
    const jobs = await preparation.preparationJobs(id);
    expect(jobs[0]?.log.length).toBe(65536);
    expect(jobs[0]?.startedAt).toBeTruthy();
    expect(jobs[0]?.finishedAt).toBeTruthy();
    await preparation.prepareProject(id);
    expect(scaffoldCalls).toBe(1);
    expect(installCalls).toBe(1);
    fingerprint = 'changed';
    await expect(preparation.assertPrepared(id)).rejects.toThrow('Dependencies need preparation');
    await preparation.prepareProject(id);
    expect(installCalls).toBe(2);
    expect(scaffoldCalls).toBe(1);
  });
  it('retries failed installation without scaffolding or failing the healthy workspace', async () => {
    status = 'failed';
    await expect(preparation.prepareProject(id)).rejects.toThrow('Dependency installation failed');
    expect((await project()).state).toBe('running');
    expect((await project()).preparation.scaffolded).toBe(true);
    status = 'succeeded';
    await preparation.prepareProject(id);
    expect(scaffoldCalls).toBe(1);
    expect(installCalls).toBe(2);
  });
  it('cancels active preparation and leaves it retryable', async () => {
    status = 'running';
    const running = preparation.prepareProject(id);
    await vi.waitFor(() => expect(installCalls).toBe(1));
    await preparation.cancelProjectWork(id);
    await expect(running).rejects.toThrow(/cancelled/);
    expect((await project()).preparation.status).toBe('interrupted');
    status = 'succeeded';
    await preparation.prepareProject(id);
    expect(scaffoldCalls).toBe(1);
  });
  it('continues storage monitoring during preparation and records quota cancellation', async () => {
    await db.db.insert(schema.installation).values({ id: 1, limits: defaultLimits });
    status = 'running';
    const originalBridge = fake.bridge.getMockImplementation()!;
    fake.bridge.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === '/usage') {
        status = 'cancelled';
        return { bytes: 6000 * 1024 * 1024, exceeded: true };
      }
      return originalBridge(...args);
    });
    fake.workerJson.mockResolvedValue({ running: true, oomKilled: false });
    const running = preparation.prepareProject(id).catch((error: Error) => error);
    try {
      await vi.waitFor(() => expect(installCalls).toBe(1));
      await (await import('../apps/api/src/lifecycle.js')).monitor();
      expect(fake.bridge.mock.calls.some((call) => call[1] === '/usage')).toBe(true);
      expect((await running)?.message).toContain('Dependency installation cancelled');
      expect((await project()).storageExceeded).toBe(true);
      expect((await project()).preparation.status).toBe('failed');
    } finally {
      await preparation.cancelProjectWork(id);
      await running;
    }
  });
  it.each(['', '   '])('scaffolds without running an empty setup command (%j)', async (command) => {
    await db.db
      .update(schema.projects)
      .set({ setupCommand: command })
      .where(eq(schema.projects.id, id));
    await preparation.prepareProject(id);
    expect(scaffoldCalls).toBe(1);
    expect(installCalls).toBe(0);
    expect((await project()).preparation.status).toBe('none');
    expect((await preparation.assertPrepared(id)).preparation.scaffolded).toBe(true);
  });
  it('reconciles interrupted preparation without silently running installation again', async () => {
    await db.db
      .update(schema.projects)
      .set({
        preparation: { status: 'installing', scaffolded: true, fingerprint: null, error: null },
      })
      .where(eq(schema.projects.id, id));
    await db.db
      .insert(schema.jobs)
      .values({ projectId: id, kind: 'prepare', state: 'running', step: 'installing' });
    fake.workerJson.mockImplementation(async (route: string) =>
      route.endsWith('/preview') ? { port: 41000 } : { running: true, oomKilled: false },
    );
    await (await import('../apps/api/src/lifecycle.js')).reconcile();
    expect((await project()).state).toBe('running');
    expect((await project()).preparation.status).toBe('interrupted');
    expect((await preparation.preparationJobs(id))[0]?.state).toBe('failed');
    expect(installCalls).toBe(0);
  });
  it('shows troubleshooting after 60 seconds without stopping the app or updating idle activity', async () => {
    const before = (await project()).lastActiveAt.getTime();
    fake.bridge.mockResolvedValue([{ isRun: true, alive: true }]);
    fake.workerJson.mockResolvedValue({ responding: false });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await preparation.probePreview(id, 3000);
      vi.setSystemTime(Date.now() + 61000);
      await expect.poll(async () => (await project()).appStatus.status).toBe('timeout');
      expect((await project()).appStatus.error).toContain('still running');
      expect((await project()).lastActiveAt.getTime()).toBe(before);
      expect(fake.bridge.mock.calls.some((call) => call[1] === '/run/stop')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('makes HTTP errors previewable and never extends idle activity', async () => {
    const before = (await project()).lastActiveAt.getTime();
    fake.workerJson.mockResolvedValue({ responding: true, httpStatus: 500 });
    await preparation.probePreview(id, 3000);
    await vi.waitFor(async () => expect((await project()).appStatus.status).toBe('available'));
    expect((await project()).appStatus.httpStatus).toBe(500);
    expect((await project()).lastActiveAt.getTime()).toBe(before);
    expect(fake.workerJson.mock.calls[0]?.[2]).toEqual({ port: 3000 });
  });
});
