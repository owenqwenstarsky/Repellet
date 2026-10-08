import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import { safeRelativePath, workspaceCursorSchema } from '@repellet/shared';
import { config, allowedOrigins } from './config.js';
import { db, pool } from './db.js';
import { installation, projects } from './schema.js';
import { agentRoutes } from './agent.js';
import { githubRoutes } from './github.js';
import { routes } from './routes.js';
import { requireUser, projectAccess, SESSION_COOKIE } from './security.js';
import {
  track,
  subscribeWorkspaceEvents,
  enableWorkspaceJournal,
  closeWorkspaceConnections,
} from './live.js';
import { attachDocument } from './collaboration.js';
import { workerJson } from './worker.js';
import { workspaceContext } from './workspaceContext.js';
import { workspaceRoutes } from './workspaceRoutes.js';
import { idempotencyHooks } from './idempotency.js';
import { auditHooks } from './audit.js';
export async function createApp(options: { static?: boolean; logger?: boolean } = {}) {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 12 * 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
  enableWorkspaceJournal();
  app.addHook('onClose', closeWorkspaceConnections);
  app.addHook('onRequest', (req, reply, done) => {
    reply.header('x-request-id', req.id);
    workspaceContext.run({ requestId: req.id }, done);
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
  idempotencyHooks(app);
  auditHooks(app);
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; code?: string; completedFiles?: string[] };
    if (e instanceof ZodError)
      return reply
        .code(400)
        .send({ error: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (e.code === '23505')
      return reply.code(409).send({ error: 'That name or item already exists' });
    if (!e.statusCode || e.statusCode >= 500) req.log.error(e);
    if (e.code === 'SESSION_UNAUTHORIZED') reply.header('x-repellet-auth', 'session');
    return reply.code(e.statusCode || 500).send({
      error: e.message || 'Request failed',
      ...(e.completedFiles ? { completedFiles: e.completedFiles } : {}),
    });
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    if (req.url.startsWith('/internal/')) return;
    if (req.url.startsWith('/ws/') || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.headers.origin || !allowedOrigins.has(req.headers.origin))
        return reply.code(403).send({ error: 'Request origin is not allowed' });
    }
    if (!['GET', 'HEAD'].includes(req.method) && !req.url.startsWith('/api/auth/logout')) {
      const [row] = await db
        .select({ maintenance: installation.maintenance })
        .from(installation)
        .where(eq(installation.id, 1));
      if (row?.maintenance)
        return reply.code(503).send({ error: 'Installation is paused for backup or maintenance' });
    }
  });
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    let worker = true;
    try {
      await workerJson('/health');
    } catch {
      worker = false;
    }
    return { ok: true, worker, version: '0.1.0' };
  });
  await routes(app);
  await workspaceRoutes(app);
  await githubRoutes(app);
  await agentRoutes(app);
  app.get('/ws/projects/:id/events', { websocket: true }, async (ws, req) => {
    try {
      const user = await requireUser(req);
      const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
      const p = await projectAccess(user, id);
      const query = req.query as { cursor?: string; protocol?: string };
      if (query.protocol && query.protocol !== '1')
        throw new Error('Unsupported workspace protocol');
      const sequenced = query.protocol === '1' || query.cursor !== undefined;
      const cursor =
        query.cursor === undefined ? undefined : workspaceCursorSchema.parse(query.cursor);
      const connection = {
        role: p.role,
        userId: user.id,
        projectId: id,
        token: req.cookies[SESSION_COOKIE]!,
        events: true,
        displayName: user.displayName,
      };
      if (sequenced) await subscribeWorkspaceEvents(ws, connection, cursor);
      else track(ws, connection);
      ws.on('message', () => {});
    } catch (e) {
      ws.close(1008, (e as Error).message.slice(0, 120));
    }
  });
  app.get('/ws/projects/:id/document', { websocket: true }, async (ws, req) => {
    try {
      const user = await requireUser(req);
      const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
      const p = await projectAccess(user, id);
      if (p.state !== 'running') throw new Error('Workspace is stopped');
      const path = safeRelativePath(String((req.query as { path: string }).path));
      track(ws, {
        userId: user.id,
        projectId: id,
        token: req.cookies[SESSION_COOKIE]!,
        events: false,
        displayName: user.displayName,
      });
      await attachDocument(ws, id, path, p.role !== 'viewer');
    } catch (e) {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'error', message: (e as Error).message }));
      ws.close(1008, (e as Error).message.slice(0, 120));
    }
  });
  app.get('/ws/projects/:id/channel', { websocket: true }, async (ws, req) => {
    const pending: { data: Buffer; binary: boolean }[] = [];
    let upstream: WebSocket | undefined;
    let editable = false;
    let channel = '';
    const forward = (data: Buffer, binary: boolean) => {
      if (ws.readyState !== 1) return;
      if (channel.startsWith('/terminals/') && !editable) return;
      if (channel.startsWith('/language/') && !editable) {
        try {
          const msg = JSON.parse(data.toString());
          if (
            [
              'textDocument/formatting',
              'textDocument/rangeFormatting',
              'workspace/executeCommand',
              'workspace/applyEdit',
            ].includes(msg.method)
          )
            return;
        } catch {
          return;
        }
      }
      if (upstream?.readyState === 1) upstream.send(data, { binary });
      else if (pending.length < 30) pending.push({ data, binary });
    };
    ws.on('message', (raw, binary) => forward(Buffer.from(raw as Buffer), binary));
    ws.on('close', () => upstream?.close());
    try {
      const user = await requireUser(req);
      const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
      const p = await projectAccess(user, id);
      if (p.state !== 'running') throw new Error('Workspace is stopped');
      channel = String((req.query as { path: string }).path || '');
      if (!/^\/(terminals\/[a-z0-9-]+\/connect|language\/(python|node|go|rust))$/.test(channel))
        throw new Error('Unsupported channel');
      editable = p.role !== 'viewer';
      track(ws, {
        userId: user.id,
        projectId: id,
        token: req.cookies[SESSION_COOKIE]!,
        events: false,
        displayName: user.displayName,
      });
      upstream = new WebSocket(
        `${config.workerUrl.replace(/^http/, 'ws')}/projects/${id}/ws?path=${encodeURIComponent(channel)}&readOnly=${!editable}`,
        { headers: { authorization: `Bearer ${config.workerToken}` } },
      );
      upstream.on('open', () => {
        if (channel.startsWith('/language/') && ws.readyState === 1)
          ws.send(JSON.stringify({ method: 'repellet/ready' }));
        for (const item of pending.splice(0)) forward(item.data, item.binary);
      });
      upstream.on('message', (data, binary) => {
        if (ws.readyState === 1) ws.send(data, { binary });
      });
      upstream.on('error', () => ws.close(1011, 'Workspace channel unavailable'));
      upstream.on('close', () => ws.close());
    } catch (e) {
      ws.close(1008, (e as Error).message.slice(0, 120));
    }
  });
  if (options.static !== false) {
    try {
      await fs.access(config.webDir);
      await app.register(staticFiles, { root: config.webDir, prefix: '/' });
      app.setNotFoundHandler((req, reply) => {
        if (
          req.url.startsWith('/api/') ||
          req.url.startsWith('/ws/') ||
          req.url.startsWith('/internal/')
        )
          return reply.code(404).send({ error: 'Not found' });
        return reply.sendFile('index.html');
      });
    } catch {
      app.log.info('Frontend not built; use Vite during development.');
    }
  }
  return app;
}
