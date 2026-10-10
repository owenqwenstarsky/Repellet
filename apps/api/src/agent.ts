import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from './db.js';
import { projects } from './schema.js';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { Readable } from 'node:stream';
import {
  agentSettingsSchema,
  agentRpcSchema,
  MAX_AGENT_IMAGE_BYTES,
  agentAttachmentUploadSchema,
} from '@repellet/shared';
import { requireUser, projectAgentAccess, SESSION_COOKIE } from './security.js';
import { workerJson, workerRequest } from './worker.js';
import { flushProject } from './collaboration.js';
import { serialize } from './lifecycle.js';
import { track } from './live.js';
import { config } from './config.js';
export async function agentRoutes(app: FastifyInstance) {
  await app.register(async (uploads) => {
    uploads.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_AGENT_IMAGE_BYTES },
      (_req, body, done) => done(null, body),
    );
    const authorized = async (req: Parameters<typeof requireUser>[0]) => {
      const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
      await projectAgentAccess(await requireUser(req), id);
    };
    uploads.post(
      '/api/projects/:id/agent/attachments',
      {
        bodyLimit: MAX_AGENT_IMAGE_BYTES,
        onRequest: authorized,
        config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      },
      async (req) => {
        const id = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);
        const meta = agentAttachmentUploadSchema.parse(req.query);
        if (!Buffer.isBuffer(req.body))
          throw Object.assign(new Error('Send attachment bytes as application/octet-stream'), {
            statusCode: 400,
          });
        return serialize(id, async () => {
          await authorized(req);
          const query = new URLSearchParams(meta).toString();
          return workerJson(`/projects/${id}/agent/attachments?${query}`, 'POST', req.body);
        });
      },
    );
    uploads.get('/api/projects/:id/agent/attachments/:attachmentId', async (req, reply) => {
      const params = z
        .object({ id: z.string().uuid(), attachmentId: z.string().uuid() })
        .parse(req.params);
      await projectAgentAccess(await requireUser(req), params.id, false);
      const response = await workerRequest(
        `/projects/${params.id}/agent/attachments/${params.attachmentId}`,
      );
      return reply
        .header('content-type', response.headers.get('content-type') || 'application/octet-stream')
        .header('content-disposition', response.headers.get('content-disposition') || 'attachment')
        .send(Readable.fromWeb(response.body as never));
    });
  });
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
