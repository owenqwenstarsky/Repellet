import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from './db.js';
import { workspaceActivity } from './schema.js';
import { workspaceContext } from './workspaceContext.js';
/** Audit only route identity and result. Never persist request bodies, query strings or secrets. */
export function auditHooks(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    const context = workspaceContext.getStore();
    if (!context?.projectId || !context.actor || ['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      return;
    if (req.method === 'DELETE' && /^\/api\/projects\/[^/]+$/.test(req.url)) return; // Project and audit rows have been removed.
    const action = `${req.method} ${req.routeOptions.url}`;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(workspaceActivity).values({
          projectId: context.projectId!,
          actor: context.actor,
          action,
          metadata: { statusCode: reply.statusCode, requestId: req.id },
        });
        await tx.execute(sql`DELETE FROM workspace_activity WHERE project_id=${context.projectId!}
          AND id NOT IN (SELECT id FROM workspace_activity WHERE project_id=${context.projectId!} ORDER BY created_at DESC LIMIT 2000)`);
      });
    } catch (error) {
      req.log.error(
        { err: error, projectId: context.projectId },
        'Workspace audit persistence failed',
      );
    }
  });
}
