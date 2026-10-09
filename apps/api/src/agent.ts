import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { projects } from './schema.js';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { agentSettingsSchema, agentRpcSchema } from '@repellet/shared';
import { requireUser, projectAgentAccess, SESSION_COOKIE } from './security.js';
import { workerJson } from './worker.js';
import { flushProject } from './collaboration.js';
import { serialize } from './lifecycle.js';
import { track } from './live.js';
import { config } from './config.js';
export async function agentRoutes(app: FastifyInstance) {
  for (const operation of ['settings', 'account'] as const)
    app.get(`/api/agent/${operation}`, async (req) => {
      const user = await requireUser(req);
      return workerJson(`/agent/users/${user.id}/${operation}`);
    });
  app.post('/api/agent/import', async (req) => {
    const user = await requireUser(req);
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const owned = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.ownerId, user.id));
    return workerJson(`/agent/users/${user.id}/import`, 'POST', {
      projectIds: owned.map((p) => p.id),
    });
  });
  app.put('/api/agent/settings', async (req) => {
    const user = await requireUser(req);
    return workerJson(
      `/agent/users/${user.id}/settings`,
      'PUT',
      agentSettingsSchema.parse(req.body),
    );
  });
  for (const operation of ['login', 'login/cancel', 'logout'] as const)
    app.post(`/api/agent/${operation}`, async (req) => {
      const user = await requireUser(req);
      const body =
        operation === 'login/cancel'
          ? z.object({ loginId: z.string().uuid() }).strict().parse(req.body)
          : z
              .object({})
              .strict()
              .parse(req.body ?? {});
      return workerJson(`/agent/users/${user.id}/${operation}`, 'POST', body);
    });
  app.get('/api/projects/:id/agent/status', async (req) => {
    const user = await requireUser(req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    await projectAgentAccess(user, id);
    return workerJson(`/projects/${id}/agent/status`, 'POST', { userId: user.id });
  });
  app.post('/api/projects/:id/agent/rpc', async (req) => {
    const user = await requireUser(req);
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    await projectAgentAccess(user, id);
    const rpc = agentRpcSchema.parse(req.body);
    return serialize(id, async () => {
      await projectAgentAccess(user, id); // Recheck state after waiting for stop/rebuild.
      if (['turn/start', 'turn/steer', 'thread/compact/start'].includes(rpc.method))
        await flushProject(id);
      return workerJson(`/projects/${id}/agent/rpc`, 'POST', { userId: user.id, rpc });
    });
  });
  app.get('/ws/projects/:id/agent', { websocket: true }, async (client, req) => {
    let upstream: WebSocket | undefined;
    client.on('message', () => client.close(1008, 'Agent channel is receive-only'));
    client.on('close', () => upstream?.close());
    try {
      const user = await requireUser(req);
      const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
      await projectAgentAccess(user, id);
      // events:false keeps all private agent traffic out of project-wide broadcasting.
      track(client, {
        userId: user.id,
        projectId: id,
        token: req.cookies[SESSION_COOKIE]!,
        events: false,
        displayName: user.displayName,
      });
      if (client.readyState !== 1) return;
      upstream = new WebSocket(
        `${config.workerUrl.replace(/^http/, 'ws')}/projects/${id}/agent/ws?userId=${encodeURIComponent(user.id)}`,
        {
          headers: { authorization: `Bearer ${config.workerToken}` },
          maxPayload: 16 * 1024 * 1024,
        },
      );
      upstream.on('message', (data) => {
        if (client.readyState === 1) client.send(data.toString());
      });
      upstream.on('error', () =>
        client.close(1011, 'Agent unavailable. Refresh status and check Agent settings.'),
      );
      upstream.on('close', () => client.close());
      upstream.on('open', () => {
        if (client.readyState !== 1) upstream?.close();
      });
    } catch (e) {
      client.close(1008, (e as Error).message.slice(0, 120));
    }
  });
}
