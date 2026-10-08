import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, lt } from 'drizzle-orm';
import { db } from './db.js';
import { workspaceIdempotency } from './schema.js';
import { requireUser, projectAccess } from './security.js';
import { z } from 'zod';
const pending = new WeakMap<FastifyRequest, { userId: string; key: string }>();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, canonical(val)]),
    );
  return value;
}
/** Retried side effects never execute twice, including after a lost HTTP response. */
export function idempotencyHooks(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    const match = /^\/api\/projects\/([0-9a-f-]+)(?:\/(open|stop|duplicate|environment))?$/.exec(
      req.url.split('?')[0]!,
    );
    if (!match || !['POST', 'PUT', 'DELETE'].includes(req.method)) return;
    if (!(match[2] || req.method === 'DELETE')) return;
    const header = req.headers['idempotency-key'];
    if (header === undefined) return; // Old clients remain compatible.
    const key = z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .parse(header);
    const user = await requireUser(req);
    const projectId = z.string().uuid().parse(match[1]);
    const hash = createHash('sha256')
      .update(
        JSON.stringify(canonical({ method: req.method, url: req.url, body: req.body ?? null })),
      )
      .digest('hex');
    const identity = and(
      eq(workspaceIdempotency.userId, user.id),
      eq(workspaceIdempotency.key, key),
    );
    const [cached] = await db.select().from(workspaceIdempotency).where(identity);
    if (cached) {
      if (cached.requestHash !== hash)
        return reply
          .code(409)
          .send({ error: 'Idempotency key was already used for another request' });
      // Deleted projects have no content to authorize; only the original caller gets its receipt.
      if (req.method !== 'DELETE') await projectAccess(user, projectId);
      if (cached.state !== 'completed')
        return reply.code(409).send({
          error:
            'Operation is pending or its outcome is unknown. Refresh workspace state before retrying with a new key.',
        });
      return reply
        .code(cached.statusCode!)
        .header('idempotency-replayed', 'true')
        .send(cached.response);
    }
    await projectAccess(
      user,
      projectId,
      match[2] === 'open' || match[2] === 'duplicate'
        ? 'view'
        : match[2] === 'stop'
          ? 'run'
          : 'manage',
    );
    await db
      .delete(workspaceIdempotency)
      .where(lt(workspaceIdempotency.createdAt, new Date(Date.now() - 86400000)));
    const inserted = await db
      .insert(workspaceIdempotency)
      .values({ userId: user.id, key, requestHash: hash, state: 'pending' })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length)
      return reply
        .code(409)
        .send({ error: 'An operation with this idempotency key is already pending' });
    pending.set(req, { userId: user.id, key });
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const identity = pending.get(req);
    if (!identity || reply.statusCode >= 500) return payload;
    pending.delete(req);
    const response = typeof payload === 'string' ? JSON.parse(payload) : null;
    await db
      .update(workspaceIdempotency)
      .set({ state: 'completed', statusCode: reply.statusCode, response })
      .where(
        and(
          eq(workspaceIdempotency.userId, identity.userId),
          eq(workspaceIdempotency.key, identity.key),
        ),
      );
    return payload;
  });
}
