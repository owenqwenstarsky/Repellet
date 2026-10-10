import { environmentSnapshot, saveEnvironment } from './environment.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, or, inArray, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  starterCatalog,
  suggestSetup,
  credentialsSchema,
  userCreateSchema,
  projectCreateSchema,
  runtimesSchema,
  runConfigSchema,
  environmentSchema,
  limitsSchema,
  safeRelativePath,
} from '@repellet/shared';
import { db } from './db.js';
import { startProfile, stopProcess } from './processes.js';
import { mainAppRunning } from './appActivity.js';
import type { TerminalInfo } from '@repellet/shared';
import {
  users,
  sessions,
  installation,
  projects,
  members,
  documents,
  jobs,
  projectRunProfiles,
  workspaceProcesses,
} from './schema.js';
import { config } from './config.js';
import {
  requireUser,
  requireOwner,
  projectAccess,
  issueSession,
  publicUser,
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  tokenMatches,
  tokenHash,
  SESSION_COOKIE,
  userForToken,
} from './security.js';
import { bridge, workerJson, workerRequest } from './worker.js';
import {
  ensureProject,
  stopProject,
  stopProjectWithinOperation,
  serialize,
  limits,
  setState,
} from './lifecycle.js';
import {
  flushProject,
  resolveConflict,
  structure,
  reconcileFiles,
  closeDocuments,
} from './collaboration.js';
import { revokeUser, revokeToken, emit, closeProject } from './live.js';
import {
  starterFor,
  prepareProject,
  preparationJobs,
  assertPrepared,
  probePreview,
  cancelProjectWork,
  cancelReadiness,
} from './preparation.js';
import { validateRepository, userToken, githubIdentity } from './github.js';
export function idFrom(req: FastifyRequest) {
  return z
    .string()
    .uuid()
    .parse((req.params as { id: string }).id);
}
export async function access(req: FastifyRequest, mode: 'view' | 'edit' | 'manage' = 'view') {
  return projectAccess(await requireUser(req), idFrom(req), mode);
}
const viewProject = async (
  p: typeof projects.$inferSelect & { role?: string; ownerName?: string },
) => {
  const { environment, cloneUrl, lastActiveAt, ...rest } = p;
  return { ...rest, running: await mainAppRunning(p) };
};
async function ready(req: FastifyRequest, mode: 'view' | 'edit' | 'manage' = 'view') {
  const p = await access(req, mode);
  if (p.state !== 'running')
    throw Object.assign(new Error('Open the workspace first'), { statusCode: 409 });
  return p;
}
export async function routes(app: FastifyInstance) {
  app.get('/api/setup/status', async () => {
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.isOwner, true));
    return { required: !owner };
  });
  app.post(
    '/api/setup',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = userCreateSchema.extend({ token: z.string().min(1).max(200) }).parse(req.body);
      const passwordHash = await hashPassword(body.password);
      const owner = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(724912)`);
        const [existing] = await tx.select().from(users).where(eq(users.isOwner, true));
        if (existing)
          throw Object.assign(new Error('Setup is already complete'), { statusCode: 409 });
        const [install] = await tx.select().from(installation).where(eq(installation.id, 1));
        if (!install?.setupToken || !tokenMatches(body.token, decrypt(install.setupToken)))
          throw Object.assign(new Error('Invalid setup token'), { statusCode: 403 });
        const [created] = await tx
          .insert(users)
          .values({
            username: body.username.toLowerCase(),
            displayName: body.displayName,
            passwordHash,
            isOwner: true,
          })
          .returning();
        await tx.update(installation).set({ setupToken: null }).where(eq(installation.id, 1));
        return created!;
      });
      return { user: await issueSession(owner, reply) };
    },
  );
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const b = credentialsSchema.parse(req.body);
      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.username, b.username.toLowerCase()));
      if (!user || !user.enabled || !(await verifyPassword(user.passwordHash, b.password)))
        throw Object.assign(new Error('Invalid username or password'), { statusCode: 401 });
      return { user: await issueSession(user, reply) };
    },
  );
  app.get('/api/auth/me', async (req) => ({ user: publicUser(await requireUser(req)) }));
  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
      revokeToken(token);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.post('/api/auth/password', async (req, reply) => {
    const user = await requireUser(req);
    const b = z
      .object({ currentPassword: z.string(), password: credentialsSchema.shape.password })
      .parse(req.body);
    if (!(await verifyPassword(user.passwordHash, b.currentPassword)))
      throw Object.assign(new Error('Current password is incorrect'), { statusCode: 403 });
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(b.password) })
      .where(eq(users.id, user.id));
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    revokeUser(user.id);
    await workerJson('/revoke', 'POST', { userId: user.id }).catch(() => {});
    return { user: await issueSession(user, reply) };
  });
  app.get('/api/users', async (req) => {
    await requireUser(req);
    return (await db.select().from(users).where(eq(users.enabled, true))).map(publicUser);
  });
  app.get('/api/admin/users', async (req) => {
    await requireOwner(req);
    return (await db.select().from(users).orderBy(users.createdAt)).map(publicUser);
  });
  app.post('/api/admin/users', async (req, reply) => {
    await requireOwner(req);
    const b = userCreateSchema.parse(req.body);
    const [user] = await db
      .insert(users)
      .values({
        username: b.username.toLowerCase(),
        displayName: b.displayName,
        passwordHash: await hashPassword(b.password),
      })
      .returning();
    return reply.code(201).send(publicUser(user!));
  });
  app.patch('/api/admin/users/:id', async (req) => {
    await requireOwner(req);
    const id = idFrom(req);
    const b = z
      .object({
        enabled: z.boolean().optional(),
        password: credentialsSchema.shape.password.optional(),
        displayName: z.string().trim().min(1).max(80).optional(),
      })
      .parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, id));
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
    if (user.isOwner && b.enabled === false)
      throw Object.assign(new Error('The owner account cannot be disabled'), { statusCode: 400 });
    await db
      .update(users)
      .set({
        enabled: b.enabled,
        displayName: b.displayName,
        ...(b.password ? { passwordHash: await hashPassword(b.password) } : {}),
      })
      .where(eq(users.id, id));
    if (b.enabled === false) await workerJson(`/agent/users/${id}/stop`, 'POST').catch(() => {});
    if (b.password || b.enabled === false) {
      await db.delete(sessions).where(eq(sessions.userId, id));
      revokeUser(id);
      await workerJson('/revoke', 'POST', { userId: id }).catch(() => {});
    }
    return { ok: true };
  });
  app.get('/api/admin/settings', async (req) => {
    await requireOwner(req);
    return { limits: await limits() };
  });
  app.put('/api/admin/settings', async (req) => {
    await requireOwner(req);
    const next = limitsSchema.parse((req.body as { limits: unknown }).limits);
    await db.update(installation).set({ limits: next }).where(eq(installation.id, 1));
    for (const p of await db.select().from(projects).where(eq(projects.state, 'running'))) {
      await workerJson(`/projects/${p.id}/ensure`, 'POST', {
        runtimes: p.runtimes,
        limits: next,
        environment: p.environment ? JSON.parse(decrypt(p.environment)) : {},
        previewTargetPort: p.runConfig.port,
      });
    }
    return { ok: true };
  });
  app.get('/api/admin/projects', async (req) => {
    const admin = await requireOwner(req);
    return Promise.all(
      (
        await db
          .select({
            id: projects.id,
            name: projects.name,
            ownerId: projects.ownerId,
            state: projects.state,
            storageBytes: projects.storageBytes,
            storageExceeded: projects.storageExceeded,
            ownerName: users.displayName,
            memberId: members.userId,
          })
          .from(projects)
          .innerJoin(users, eq(projects.ownerId, users.id))
          .leftJoin(members, and(eq(members.projectId, projects.id), eq(members.userId, admin.id)))
          .orderBy(desc(projects.updatedAt))
      ).map(async ({ ownerId, memberId, ...p }) => ({
        ...p,
        running: await mainAppRunning(p),
        canOpen: ownerId === admin.id || !!memberId,
      })),
    );
  });
  app.post('/api/admin/projects/:id/stop', async (req) => {
    await requireOwner(req);
    const id = idFrom(req);
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, id));
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    await stopProject(id);
    return { ok: true };
  });
  app.get('/api/projects', async (req) => {
    const user = await requireUser(req);
    const list = await db
      .select({ project: projects, role: members.role, ownerName: users.displayName })
      .from(projects)
      .innerJoin(users, eq(projects.ownerId, users.id))
      .leftJoin(members, and(eq(members.projectId, projects.id), eq(members.userId, user.id)))
      .where(or(eq(projects.ownerId, user.id), eq(members.userId, user.id)))
      .orderBy(desc(projects.updatedAt));
    return Promise.all(
      list.map(({ project, role, ownerName }) =>
        viewProject({ ...project, role: project.ownerId === user.id ? 'owner' : role!, ownerName }),
      ),
    );
  });
  app.get('/api/starters', async (req) => {
    await requireUser(req);
    return starterCatalog;
  });
  app.post('/api/projects', async (req, reply) => {
    const user = await requireUser(req);
    const b = projectCreateSchema.parse(req.body);
    const source = b.githubSource ? await validateRepository(user.id, b.githubSource) : null;
    const starter = starterFor(b.starterId);
    const primary = b.runtimes[0];
    const command =
      primary === 'python'
        ? 'python -m http.server 8000 --bind 0.0.0.0'
        : primary === 'node'
          ? 'npm run dev -- --host 0.0.0.0'
          : primary === 'go'
            ? 'go run .'
            : 'cargo run';
    const [p] = await db
      .insert(projects)
      .values({
        ownerId: user.id,
        name: b.name,
        description: b.description,
        runtimes: starter ? [...starter.runtimes] : b.runtimes,
        repository: source
          ? {
              repositoryId: source.id,
              installationId: source.installationId,
              fullName: source.fullName,
              cloneUrl: source.cloneUrl,
              userId: user.id,
              cloned: false,
            }
          : null,
        starterId: starter?.id || null,
        starterVersion: starter?.version || null,
        setupCommand: starter?.setupCommand || '',
        preparation: {
          status: starter ? 'pending' : 'none',
          scaffolded: false,
          fingerprint: null,
          error: null,
        },
        cloneUrl: b.cloneUrl || null,
        runConfig: starter?.runConfig || {
          command: source || b.cloneUrl ? '' : command,
          cwd: '',
          port: primary === 'python' ? 8000 : 3000,
        },
      })
      .returning();
    if (starter || source)
      void ensureProject(p!.id)
        .then(() => (starter ? prepareProject(p!.id) : undefined))
        .catch((e) => req.log.error(e));
    return reply.code(201).send(await viewProject({ ...p!, role: 'owner' }));
  });
  app.get('/api/projects/:id', async (req) => viewProject(await access(req)));
  app.patch('/api/projects/:id', async (req) => {
    const p = await access(req, 'manage');
    const b = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        runConfig: runConfigSchema.optional(),
        setupCommand: z.string().trim().max(4096).optional(),
        runAutoStart: z.boolean().optional(),
      })
      .parse(req.body);
    if (b.runConfig) b.runConfig.cwd = safeRelativePath(b.runConfig.cwd);
    const configuring =
      b.runConfig !== undefined || b.setupCommand !== undefined || b.runAutoStart !== undefined;
    const assertIdle = (current: typeof projects.$inferSelect) => {
      if (configuring && ['files', 'installing'].includes(current.preparation.status))
        throw Object.assign(
          new Error(
            'Installation is in progress. Wait for it to finish before saving Run settings.',
          ),
          { statusCode: 409 },
        );
    };
    assertIdle(p);
    await serialize(p.id, async () => {
      const current = await access(req, 'manage');
      assertIdle(current);
      if (
        b.runConfig &&
        b.runConfig.port !== current.runConfig.port &&
        current.state === 'running'
      ) {
        await cancelProjectWork(p.id);
        await stopProjectWithinOperation(p.id);
      }
      const { runAutoStart, ...fields } = b;
      const setupChanged = b.setupCommand !== undefined && b.setupCommand !== current.setupCommand;
      const folderChanged = b.runConfig !== undefined && b.runConfig.cwd !== current.runConfig.cwd;
      const installationRequired =
        !!(b.setupCommand ?? current.setupCommand).trim() ||
        !!(current.starterId && !current.preparation.scaffolded);
      await db.transaction(async (tx) => {
        await tx
          .update(projects)
          .set({
            ...fields,
            ...(setupChanged || folderChanged
              ? {
                  preparation: {
                    ...current.preparation,
                    status: installationRequired ? ('required' as const) : ('none' as const),
                    fingerprint: null,
                    error: null,
                  },
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(projects.id, p.id));
        if (runAutoStart !== undefined)
          await tx
            .update(projectRunProfiles)
            .set({ autoStart: runAutoStart })
            .where(
              and(eq(projectRunProfiles.projectId, p.id), eq(projectRunProfiles.isDefault, true)),
            );
      });
      await emit(p.id, { type: 'project', action: 'settings.updated' });
    });
    return { ok: true };
  });
  app.post('/api/projects/:id/open', async (req, reply) => {
    const p = await access(req);
    const owner = await db.select().from(users).where(eq(users.id, p.ownerId));
    if (!owner[0]?.enabled)
      throw Object.assign(new Error('Project owner account is disabled'), { statusCode: 403 });
    void ensureProject(p.id)
      .then(() => (p.preparation.status === 'pending' ? prepareProject(p.id) : undefined))
      .catch((e) => req.log.error(e));
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/projects/:id/stop', async (req) => {
    const p = await access(req, 'edit');
    await stopProject(p.id);
    return { ok: true };
  });
  app.post('/api/projects/:id/run', async (req) => {
    const p = await ready(req, 'edit');
    const actor = await requireUser(req);
    return serialize(p.id, async () => {
      await access(req, 'edit');
      await flushProject(p.id);
      const current = await assertPrepared(p.id);
      const [profile] = await db
        .select()
        .from(projectRunProfiles)
        .where(and(eq(projectRunProfiles.projectId, p.id), eq(projectRunProfiles.isDefault, true)));
      if (!profile)
        throw Object.assign(new Error('Main Run command is unavailable'), { statusCode: 409 });
      const active = await db
        .select()
        .from(workspaceProcesses)
        .where(
          and(
            eq(workspaceProcesses.projectId, p.id),
            eq(workspaceProcesses.profileId, profile.id),
            inArray(workspaceProcesses.status, ['starting', 'running']),
          ),
        );
      for (const process of active) await stopProcess(p.id, process.id);
      const process = await startProfile(p.id, profile.id, actor.id);
      await probePreview(p.id, current.runConfig.port);
      await emit(p.id, { type: 'terminals' });
      return { ok: true, terminalId: process.id };
    });
  });
  app.post('/api/projects/:id/run/stop', async (req) => {
    const p = await ready(req, 'edit');
    await serialize(p.id, async () => {
      await access(req, 'edit');
      const active = await db
        .select({ id: workspaceProcesses.id })
        .from(workspaceProcesses)
        .innerJoin(projectRunProfiles, eq(workspaceProcesses.profileId, projectRunProfiles.id))
        .where(
          and(
            eq(workspaceProcesses.projectId, p.id),
            eq(projectRunProfiles.isDefault, true),
            inArray(workspaceProcesses.status, ['starting', 'running']),
          ),
        );
      for (const process of active) await stopProcess(p.id, process.id);
      await bridge(p.id, '/run/stop', 'POST');
      await cancelReadiness(p.id);
    });
    await emit(p.id, { type: 'terminals' });
    return { ok: true };
  });
  app.post('/api/projects/:id/setup/suggest', async (req) => {
    const p = await ready(req, 'manage');
    const b = z.object({ cwd: z.string().max(1024).default('') }).parse(req.body);
    b.cwd = safeRelativePath(b.cwd);
    return serialize(p.id, async () => {
      await flushProject(p.id);
      const { files } = await bridge<{ files: Record<string, string> }>(
        p.id,
        '/inspect',
        'POST',
        b,
      );
      return suggestSetup(files, b.cwd, new URL(config.publicUrl).hostname);
    });
  });
  app.put('/api/projects/:id/setup', async (req) => {
    const p = await ready(req, 'manage');
    const b = z
      .object({
        setupCommand: z.string().trim().max(4096),
        runConfig: runConfigSchema,
        confirmed: z.literal(true),
      })
      .parse(req.body);
    b.runConfig.cwd = safeRelativePath(b.runConfig.cwd);
    if (b.runConfig.port !== p.runConfig.port) await stopProject(p.id);
    await serialize(p.id, async () => {
      await db
        .update(projects)
        .set({
          setupCommand: b.setupCommand,
          runConfig: b.runConfig,
          preparation: {
            ...p.preparation,
            status: b.setupCommand ? 'pending' : 'none',
            fingerprint: null,
            error: null,
          },
        })
        .where(eq(projects.id, p.id));
    });
    // Saving confirmation does not execute anything; preparation is a separate explicit action.
    return { ok: true };
  });
  app.get('/api/projects/:id/preparation', async (req) => {
    const p = await access(req);
    return { preparation: p.preparation, jobs: await preparationJobs(p.id) };
  });
  app.post('/api/projects/:id/prepare', async (req, reply) => {
    const p = await ready(req, 'edit');
    void prepareProject(p.id).catch((e) => req.log.error(e));
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/projects/:id/readiness', async (req, reply) => {
    const p = await ready(req, 'edit');
    await probePreview(p.id, p.runConfig.port);
    return reply.code(202).send({ ok: true });
  });
  app.get('/api/projects/:id/build-log', async (req) => {
    const p = await access(req);
    return workerJson(`/projects/${p.id}/logs`);
  });
  app.delete('/api/projects/:id', async (req) => {
    const p = await access(req, 'manage');
    await cancelProjectWork(p.id);
    await serialize(p.id, async () => {
      await closeDocuments(p.id);
      closeProject(p.id);
      await workerJson(`/projects/${p.id}`, 'DELETE');
      await db.delete(projects).where(eq(projects.id, p.id));
    });
    return { ok: true };
  });
  app.post('/api/projects/:id/duplicate', async (req, reply) => {
    const p = await ready(req);
    await flushProject(p.id);
    const [copy] = await db
      .insert(projects)
      .values({
        ownerId: (await requireUser(req)).id,
        name: p.name + ' copy',
        description: p.description,
        runtimes: p.runtimes,
        runConfig: p.runConfig,
        setupCommand: p.setupCommand,
        starterId: p.starterId,
        starterVersion: p.starterVersion,
        preparation: {
          ...p.preparation,
          status: p.preparation.status === 'ready' ? 'ready' : 'none',
          scaffolded: true,
        },
      })
      .returning();
    try {
      await workerJson(`/projects/${p.id}/duplicate`, 'POST', { id: copy!.id });
      return reply.code(201).send(await viewProject({ ...copy!, role: 'owner' }));
    } catch (e) {
      await db.delete(projects).where(eq(projects.id, copy!.id));
      throw e;
    }
  });
  app.get('/api/projects/:id/export', async (req, reply) => {
    const p = await ready(req);
    await flushProject(p.id);
    const response = await workerRequest(`/projects/${p.id}/export`);
    return reply
      .header('content-type', 'application/x-tar')
      .header('content-disposition', `attachment; filename="${p.id}.tar"`)
      .send(Readable.fromWeb(response.body as never));
  });
  app.get('/api/projects/:id/members', async (req) => {
    const p = await access(req);
    const list = await db
      .select({ user: users, role: members.role })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.projectId, p.id));
    const [owner] = await db.select().from(users).where(eq(users.id, p.ownerId));
    return [
      { user: publicUser(owner!), role: 'owner' },
      ...list.map((m) => ({ user: publicUser(m.user), role: m.role })),
    ];
  });
  app.put('/api/projects/:id/members', async (req) => {
    const p = await access(req, 'manage');
    const b = z
      .object({ userId: z.string().uuid(), role: z.enum(['editor', 'viewer']) })
      .parse(req.body);
    if (b.userId === p.ownerId) throw new Error('Cannot change project owner role');
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, b.userId), eq(users.enabled, true)));
    if (!user) throw new Error('Choose an enabled user');
    await db
      .insert(members)
      .values({ projectId: p.id, ...b })
      .onConflictDoUpdate({ target: [members.projectId, members.userId], set: { role: b.role } });
    revokeUser(b.userId, p.id);
    await workerJson('/revoke', 'POST', { userId: b.userId, projectId: p.id }).catch(() => {});
    return { ok: true };
  });
  app.delete('/api/projects/:id/members/:userId', async (req) => {
    const p = await access(req, 'manage');
    const userId = z
      .string()
      .uuid()
      .parse((req.params as { userId: string }).userId);
    await db.delete(members).where(and(eq(members.projectId, p.id), eq(members.userId, userId)));
    revokeUser(userId, p.id);
    await workerJson('/revoke', 'POST', { userId, projectId: p.id }).catch(() => {});
    return { ok: true };
  });
  app.get('/api/projects/:id/environment', async (req) => {
    const p = await access(req, 'manage');
    return environmentSnapshot(p.id);
  });
  app.put('/api/projects/:id/environment', async (req, reply) => {
    const p = await access(req, 'manage');
    const b = z
      .object({
        runtimes: runtimesSchema,
        variables: environmentSchema,
        revision: z.number().int().min(0).optional(),
        databaseVariableName: z.string().nullable().optional(),
        renames: z.record(z.string(), z.string()).optional(),
      })
      .parse(req.body);
    const result = await saveEnvironment(p.id, b);
    const changed = [...b.runtimes].sort().join() !== [...p.runtimes].sort().join();
    if (changed) {
      void ensureProject(p.id, { runtimes: b.runtimes }).catch((e) => req.log.error(e));
      return reply.code(202).send({ ...result, rebuilding: true });
    }
    return result;
  });
  app.get('/api/projects/:id/files', async (req) => {
    const p = await ready(req);
    const path = safeRelativePath(String((req.query as { path?: string }).path || ''));
    return bridge(p.id, `/files?path=${encodeURIComponent(path)}`);
  });
  app.get('/api/projects/:id/file-index', async (req) => {
    const p = await ready(req);
    return bridge(p.id, '/file-index');
  });
  app.get('/api/projects/:id/file', async (req) => {
    const p = await ready(req);
    const path = safeRelativePath(String((req.query as { path: string }).path));
    return bridge(p.id, `/file?path=${encodeURIComponent(path)}`);
  });
  app.post('/api/projects/:id/files/create', async (req) => {
    const p = await ready(req, 'edit');
    const b = z.object({ path: z.string(), kind: z.enum(['file', 'directory']) }).parse(req.body);
    b.path = safeRelativePath(b.path);
    return serialize(p.id, () => bridge(p.id, '/files/create', 'POST', b));
  });
  app.post('/api/projects/:id/files/move', async (req) => {
    const p = await ready(req, 'edit');
    const b = z.object({ from: z.string(), to: z.string() }).parse(req.body);
    b.from = safeRelativePath(b.from);
    b.to = safeRelativePath(b.to);
    return serialize(p.id, () =>
      structure(p.id, b.from, b.to, () => bridge(p.id, '/files/move', 'POST', b)),
    );
  });
  app.post('/api/projects/:id/files/delete', async (req) => {
    const p = await ready(req, 'edit');
    const b = z.object({ path: z.string() }).parse(req.body);
    b.path = safeRelativePath(b.path);
    return serialize(p.id, () =>
      structure(p.id, b.path, undefined, () => bridge(p.id, '/files/delete', 'POST', b)),
    );
  });
  app.post('/api/projects/:id/files/upload', async (req) => {
    const p = await ready(req, 'edit');
    const b = z
      .object({ path: z.string(), data: z.string().max(12 * 1024 * 1024) })
      .parse(req.body);
    b.path = safeRelativePath(b.path);
    return serialize(p.id, () => bridge(p.id, '/files/upload', 'POST', b));
  });
  app.get('/api/projects/:id/files/download', async (req, reply) => {
    const p = await ready(req);
    const path = safeRelativePath(String((req.query as { path: string }).path));
    const response = await workerRequest(
      `/projects/${p.id}/download?path=${encodeURIComponent(path)}`,
    );
    const filename =
      (path.split('/').pop() || 'workspace') +
      (response.headers.get('x-repellet-archive') === 'true' ? '.tar' : '');
    return reply
      .header('content-type', response.headers.get('content-type') || 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(Readable.fromWeb(response.body as never));
  });
  app.get('/api/projects/:id/search', async (req) => {
    const p = await ready(req);
    const query = z
      .string()
      .max(1000)
      .parse((req.query as { query: string }).query);
    return bridge(p.id, `/search?query=${encodeURIComponent(query)}`);
  });
  app.post('/api/projects/:id/replace', async (req) => {
    const p = await ready(req, 'edit');
    const b = z
      .object({ query: z.string().min(1).max(1000), replacement: z.string().max(10000) })
      .parse(req.body);
    return serialize(p.id, async () => {
      await flushProject(p.id);
      let result;
      try {
        result = await bridge(p.id, '/replace', 'POST', b);
      } catch (error) {
        await reconcileFiles(p.id).catch((recoveryError) => req.log.error(recoveryError));
        throw error;
      }
      await reconcileFiles(p.id);
      return result;
    });
  });
  app.post('/api/projects/:id/conflict', async (req) => {
    const p = await ready(req, 'edit');
    const b = z.object({ path: z.string(), choice: z.enum(['disk', 'editor']) }).parse(req.body);
    return resolveConflict(p.id, safeRelativePath(b.path), b.choice);
  });
  app.get('/api/projects/:id/terminals', async (req) => {
    const p = await ready(req);
    const terminals = await bridge<(TerminalInfo & { kind?: string })[]>(p.id, '/terminals');
    const records = await db
      .select({ id: workspaceProcesses.id })
      .from(workspaceProcesses)
      .innerJoin(projectRunProfiles, eq(workspaceProcesses.profileId, projectRunProfiles.id))
      .where(and(eq(workspaceProcesses.projectId, p.id), eq(projectRunProfiles.isDefault, true)));
    const mainIds = new Set(records.map((record) => record.id));
    const main = terminals.filter((terminal) => terminal.id === 'run' || mainIds.has(terminal.id));
    // Retain only the current main Run output, preferring a live session over retired output.
    const selected = main.filter((terminal) => terminal.alive).at(-1) || main.at(-1);
    return terminals
      .filter((terminal) => {
        if (main.includes(terminal)) return terminal === selected;
        // Older installed bridges retain explicitly stopped shells; omit those as well.
        return terminal.alive || terminal.kind !== 'terminal';
      })
      .map((terminal) => ({ ...terminal, isMainRun: terminal === selected }));
  });
  app.post('/api/projects/:id/terminals', async (req) => {
    const p = await ready(req, 'edit');
    const b = z.object({ name: z.string().min(1).max(80).optional() }).parse(req.body || {});
    const terminal = await bridge(p.id, '/terminals', 'POST', b);
    emit(p.id, { type: 'terminals' });
    return terminal;
  });
  app.delete('/api/projects/:id/terminals/:terminalId', async (req) => {
    const p = await ready(req, 'edit');
    const terminalId = z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .parse((req.params as { terminalId: string }).terminalId);
    return serialize(p.id, async () => {
      await access(req, 'edit');
      const result = await bridge(p.id, `/terminals/${terminalId}`, 'DELETE');
      if (z.string().uuid().safeParse(terminalId).success)
        await db
          .update(workspaceProcesses)
          .set({ status: 'stopped', finishedAt: new Date() })
          .where(
            and(eq(workspaceProcesses.projectId, p.id), eq(workspaceProcesses.id, terminalId)),
          );
      await emit(p.id, { type: 'terminals' });
      return result;
    });
  });
  app.post('/api/projects/:id/format', async (req) => {
    const p = await ready(req, 'edit');
    const b = z
      .object({ path: z.string(), content: z.string().max(2 * 1024 * 1024) })
      .parse(req.body);
    b.path = safeRelativePath(b.path);
    return bridge(p.id, '/format', 'POST', b);
  });
  app.get('/api/projects/:id/git/status', async (req) => {
    const p = await ready(req);
    return bridge(p.id, '/git/status');
  });
  app.get('/api/projects/:id/git/diff', async (req) => {
    const p = await ready(req);
    const q = req.query as { path?: string; staged?: string };
    return bridge(
      p.id,
      `/git/diff?path=${encodeURIComponent(safeRelativePath(q.path || ''))}&staged=${q.staged === 'true'}`,
    );
  });
  app.post('/api/projects/:id/git', async (req) => {
    const p = await ready(req, 'edit');
    const user = await requireUser(req);
    const b = z
      .object({
        action: z.enum([
          'init',
          'stage',
          'unstage',
          'commit',
          'pull',
          'push',
          'branch',
          'checkout',
        ]),
        paths: z.array(z.string()).max(1000).optional(),
        message: z.string().max(10000).optional(),
        branch: z.string().max(250).optional(),
      })
      .parse(req.body);
    b.paths = b.paths?.map(safeRelativePath);
    return serialize(p.id, async () => {
      await flushProject(p.id);
      let credential: { token: string; remote: string } | undefined;
      if (p.repository && ['pull', 'push'].includes(b.action)) {
        const repo = await validateRepository(user.id, p.repository, b.action === 'push');
        credential = { token: await userToken(user.id), remote: repo.cloneUrl };
      }
      const identity = b.action === 'commit' ? await githubIdentity(user.id) : null;
      const result = await bridge(p.id, '/git', 'POST', {
        ...b,
        credential,
        name: identity?.name || user.displayName,
        email: identity?.email || `${user.username}@repellet.local`,
      });
      await reconcileFiles(p.id);
      emit(p.id, { type: 'files' });
      return result;
    });
  });
  app.post('/internal/authorize-preview', async (req) => {
    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, '') || '', config.workerToken))
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    const b = z.object({ projectId: z.string().uuid(), cookie: z.string() }).parse(req.body);
    const cookies = app.parseCookie(b.cookie);
    const user = await userForToken(cookies[SESSION_COOKIE]);
    if (!user) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    const p = await projectAccess(user, b.projectId);
    if (p.state !== 'running')
      throw Object.assign(new Error('Workspace stopped'), { statusCode: 409 });
    await db.update(projects).set({ lastActiveAt: new Date() }).where(eq(projects.id, p.id));
    return { userId: user.id };
  });
  app.post('/internal/maintenance', async (req) => {
    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, '') || '', config.workerToken))
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    const enabled = (req.body as { enabled: boolean }).enabled;
    if (enabled) {
      await db.update(installation).set({ maintenance: true }).where(eq(installation.id, 1));
      for (const p of await db
        .select()
        .from(projects)
        .where(inArray(projects.state, ['running', 'building', 'starting'])))
        await stopProject(p.id);
    } else await db.update(installation).set({ maintenance: false }).where(eq(installation.id, 1));
    return { ok: true };
  });
}
