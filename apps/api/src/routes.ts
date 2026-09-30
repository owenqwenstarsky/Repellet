import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, or, inArray, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
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
import { users, sessions, installation, projects, members, documents, jobs } from './schema.js';
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
import { ensureProject, stopProject, serialize, limits, setState } from './lifecycle.js';
import {
  flushProject,
  resolveConflict,
  structure,
  reconcileFiles,
  closeDocuments,
} from './collaboration.js';
import { revokeUser, revokeToken, emit, closeProject } from './live.js';
export function idFrom(req: FastifyRequest) {
  return z
    .string()
    .uuid()
    .parse((req.params as { id: string }).id);
}
export async function access(req: FastifyRequest, mode: 'view' | 'edit' | 'manage' = 'view') {
  return projectAccess(await requireUser(req), idFrom(req), mode);
}
const viewProject = (p: typeof projects.$inferSelect & { role?: string; ownerName?: string }) => {
  const { environment, cloneUrl, lastActiveAt, ...rest } = p;
  return rest;
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
    await requireOwner(req);
    return (
      await db
        .select({ project: projects, ownerName: users.displayName })
        .from(projects)
        .innerJoin(users, eq(projects.ownerId, users.id))
        .orderBy(desc(projects.updatedAt))
    ).map((p) => viewProject({ ...p.project, role: 'owner', ownerName: p.ownerName }));
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
    return list.map(({ project, role, ownerName }) =>
      viewProject({ ...project, role: project.ownerId === user.id ? 'owner' : role!, ownerName }),
    );
  });
  app.post('/api/projects', async (req, reply) => {
    const user = await requireUser(req);
    const b = projectCreateSchema.parse(req.body);
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
        runtimes: b.runtimes,
        cloneUrl: b.cloneUrl || null,
        runConfig: { command, cwd: '', port: primary === 'python' ? 8000 : 3000 },
      })
      .returning();
    return reply.code(201).send(viewProject({ ...p!, role: 'owner' }));
  });
  app.get('/api/projects/:id', async (req) => viewProject(await access(req)));
  app.patch('/api/projects/:id', async (req) => {
    const p = await access(req, 'manage');
    const b = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
        runConfig: runConfigSchema.optional(),
      })
      .parse(req.body);
    if (b.runConfig) safeRelativePath(b.runConfig.cwd);
    if (b.runConfig && b.runConfig.port !== p.runConfig.port && p.state === 'running')
      await stopProject(p.id);
    await db
      .update(projects)
      .set({ ...b, updatedAt: new Date() })
      .where(eq(projects.id, p.id));
    return { ok: true };
  });
  app.post('/api/projects/:id/open', async (req, reply) => {
    const p = await access(req);
    const owner = await db.select().from(users).where(eq(users.id, p.ownerId));
    if (!owner[0]?.enabled)
      throw Object.assign(new Error('Project owner account is disabled'), { statusCode: 403 });
    void ensureProject(p.id).catch((e) => req.log.error(e));
    return reply.code(202).send({ ok: true });
  });
  app.post('/api/projects/:id/stop', async (req) => {
    const p = await access(req, 'edit');
    await stopProject(p.id);
    return { ok: true };
  });
  app.post('/api/projects/:id/run', async (req) => {
    const p = await ready(req, 'edit');
    await serialize(p.id, async () => {
      await flushProject(p.id);
      await bridge(p.id, '/run', 'POST', p.runConfig);
    });
    emit(p.id, { type: 'terminals' });
    return { ok: true };
  });
  app.post('/api/projects/:id/run/stop', async (req) => {
    const p = await ready(req, 'edit');
    await bridge(p.id, '/run/stop', 'POST');
    emit(p.id, { type: 'terminals' });
    return { ok: true };
  });
  app.get('/api/projects/:id/build-log', async (req) => {
    const p = await access(req);
    return workerJson(`/projects/${p.id}/logs`);
  });
  app.delete('/api/projects/:id', async (req) => {
    const p = await access(req, 'manage');
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
      })
      .returning();
    try {
      await workerJson(`/projects/${p.id}/duplicate`, 'POST', { id: copy!.id });
      return reply.code(201).send(viewProject({ ...copy!, role: 'owner' }));
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
    return {
      runtimes: p.runtimes,
      variables: p.environment ? JSON.parse(decrypt(p.environment)) : {},
    };
  });
  app.put('/api/projects/:id/environment', async (req, reply) => {
    const p = await access(req, 'manage');
    const b = z.object({ runtimes: runtimesSchema, variables: environmentSchema }).parse(req.body);
    const changed = [...b.runtimes].sort().join() !== [...p.runtimes].sort().join();
    if (changed) {
      void ensureProject(p.id, { runtimes: b.runtimes, environment: b.variables })
        .then(() =>
          db
            .update(projects)
            .set({ environment: encrypt(JSON.stringify(b.variables)) })
            .where(eq(projects.id, p.id)),
        )
        .catch((e) => req.log.error(e));
      return reply.code(202).send({ rebuilding: true });
    }
    await db
      .update(projects)
      .set({ environment: encrypt(JSON.stringify(b.variables)), updatedAt: new Date() })
      .where(eq(projects.id, p.id));
    if (p.state === 'running') await bridge(p.id, '/environment', 'PUT', b.variables);
    return { ok: true };
  });
  app.get('/api/projects/:id/files', async (req) => {
    const p = await ready(req);
    const path = safeRelativePath(String((req.query as { path?: string }).path || ''));
    return bridge(p.id, `/files?path=${encodeURIComponent(path)}`);
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
      const result = await bridge(p.id, '/replace', 'POST', b);
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
    return bridge(p.id, '/terminals');
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
    const result = await bridge(p.id, `/terminals/${terminalId}`, 'DELETE');
    emit(p.id, { type: 'terminals' });
    return result;
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
      const result = await bridge(p.id, '/git', 'POST', {
        ...b,
        name: user.displayName,
        email: `${user.username}@repellet.local`,
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
