import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, projectId } from '../config.js';
import { docker } from '../images.js';
import {
  withAccount,
  userId,
  saveSettings,
  readAccount,
  startLogin,
  cancelLogin,
  logout,
  closeAccounts,
  importExistingHistory,
} from './accounts.js';
import {
  agentStatus,
  agentRpc,
  attachAgent,
  assertAccountIdle,
  closeUserAgents,
  stopAgent,
  agentActivity,
  agentUsage,
  closeAllAgents,
  invalidateAgentProviders,
} from './projects.js';
import { killProjectAgent } from './process.js';
import {
  MAX_AGENT_IMAGE_BYTES,
  agentAttachmentUploadSchema,
  agentApiSchema,
} from '@repellet/shared';
import {
  withProviderPolicy,
  userSettings,
  modelCatalog,
  publicGlobalSettings,
  saveGlobalSettings,
  previewGlobalModels,
  previewPersonalModels,
} from './providers.js';
import { storeAttachment, readAttachment } from './attachments.js';
import { locked, inspect } from '../workspaces.js';
export async function agentRoutes(app: FastifyInstance) {
  app.get('/agent/global', () => withProviderPolicy(publicGlobalSettings));
  app.put('/agent/global', (req) =>
    withProviderPolicy(async () => {
      const result = await saveGlobalSettings(req.body);
      await invalidateAgentProviders();
      return result;
    }),
  );
  app.post('/agent/global/models', (req) =>
    withProviderPolicy(() => previewGlobalModels(req.body)),
  );
  await app.register(async (uploads) => {
    uploads.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_AGENT_IMAGE_BYTES },
      (_req, body, done) => done(null, body),
    );
    uploads.post(
      '/projects/:id/agent/attachments',
      { bodyLimit: MAX_AGENT_IMAGE_BYTES },
      async (req) => {
        const id = projectId((req.params as { id: string }).id);
        const meta = agentAttachmentUploadSchema.parse(req.query);
        return locked(id, async () => {
          const workspace = await inspect(id);
          if (
            !workspace?.State.Running ||
            !workspace.Mounts.some((mount) => mount.Destination === '/home/agent/attachments')
          )
            throw Object.assign(new Error('Stop and start the workspace to enable attachments'), {
              statusCode: 409,
            });
          const usage = await agentUsage(id);
          const data = req.body as Buffer;
          if (!Buffer.isBuffer(data))
            throw Object.assign(new Error('Send attachment bytes as application/octet-stream'), {
              statusCode: 400,
            });
          if (
            usage.exceeded ||
            (usage.limitBytes !== undefined && usage.bytes + data.length > usage.limitBytes)
          )
            throw Object.assign(new Error('Project storage limit reached'), { statusCode: 507 });
          return storeAttachment(id, meta, data);
        });
      },
    );
    uploads.get('/projects/:id/agent/attachments/:attachmentId', async (req, reply) => {
      const params = req.params as { id: string; attachmentId: string };
      const { meta, data } = await readAttachment(projectId(params.id), params.attachmentId, true);
      return reply
        .header('content-type', meta.mimeType)
        .header(
          'content-disposition',
          `${meta.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
        )
        .header('x-content-type-options', 'nosniff')
        .send(data);
    });
  });
  const userFrom = (req: { params: unknown }) => userId((req.params as { userId: string }).userId);
  app.get('/agent/users/:userId/settings', async (req) =>
    withProviderPolicy(() => withAccount(userFrom(req), () => userSettings(userFrom(req)))),
  );
  app.get('/agent/users/:userId/models', (req) =>
    withProviderPolicy(async () => {
      const query = z
        .object({ api: agentApiSchema, refresh: z.enum(['true', 'false']).optional() })
        .strict()
        .parse(req.query);
      const result = await modelCatalog(userFrom(req), query.api, query.refresh === 'true');
      if (query.refresh === 'true') await invalidateAgentProviders(userFrom(req));
      return result;
    }),
  );
  app.post('/agent/users/:userId/models', (req) =>
    withProviderPolicy(() => previewPersonalModels(userFrom(req), req.body)),
  );
  app.put('/agent/users/:userId/settings', async (req) =>
    withProviderPolicy(() =>
      withAccount(userFrom(req), async () => {
        assertAccountIdle(userFrom(req));
        const settings = await saveSettings(userFrom(req), req.body);
        await closeUserAgents(userFrom(req));
        return settings;
      }),
    ),
  );
  app.get('/agent/users/:userId/account', async (req) =>
    withAccount(userFrom(req), () => readAccount(userFrom(req))),
  );
  app.post('/agent/users/:userId/login', async (req) =>
    withAccount(userFrom(req), async () => {
      assertAccountIdle(userFrom(req));
      await closeUserAgents(userFrom(req));
      return startLogin(userFrom(req));
    }),
  );
  app.post('/agent/users/:userId/login/cancel', async (req) =>
    withAccount(userFrom(req), () =>
      cancelLogin(
        userFrom(req),
        z.object({ loginId: z.string().uuid() }).strict().parse(req.body).loginId,
      ),
    ),
  );
  app.post('/agent/users/:userId/import', async (req) =>
    withAccount(userFrom(req), async () => {
      const { projectIds } = z
        .object({ projectIds: z.array(z.string().uuid()).max(10000) })
        .strict()
        .parse(req.body);
      await closeUserAgents(userFrom(req));
      return importExistingHistory(userFrom(req), projectIds);
    }),
  );
  app.post('/agent/users/:userId/logout', async (req) =>
    withAccount(userFrom(req), async () => {
      await closeUserAgents(userFrom(req));
      return logout(userFrom(req));
    }),
  );
  app.post('/agent/users/:userId/stop', async (req) =>
    withAccount(userFrom(req), async () => {
      await closeUserAgents(userFrom(req));
      return { ok: true };
    }),
  );
  const projectFrom = (req: { params: unknown }) => projectId((req.params as { id: string }).id);
  app.post('/projects/:id/agent/status', async (req) =>
    agentStatus(
      projectFrom(req),
      userId(z.object({ userId: z.string().uuid() }).strict().parse(req.body).userId),
    ),
  );
  app.post('/projects/:id/agent/rpc', async (req) => {
    const input = z
      .object({ userId: z.string().uuid(), rpc: z.unknown() })
      .strict()
      .parse(req.body);
    return agentRpc(projectFrom(req), userId(input.userId), input.rpc);
  });
  app.get('/projects/:id/agent/activity', async (req) => agentActivity(projectFrom(req)));
  app.get('/projects/:id/agent/usage', async (req) => agentUsage(projectFrom(req)));
  app.get('/projects/:id/agent/ws', { websocket: true }, async (client, req) => {
    // Receive-only. Browser question replies and mutations use the narrowed HTTP contract.
    client.on('message', () => client.close(1008, 'Agent channel is receive-only'));
    try {
      await attachAgent(
        client,
        projectFrom(req),
        userId(z.object({ userId: z.string().uuid() }).strict().parse(req.query).userId),
      );
    } catch {
      client.close(1011, 'Agent unavailable. Check Agent settings and workspace status.');
    }
  });
  app.addHook('onClose', async () => {
    await closeAllAgents();
    await closeAccounts();
  });
}
export async function terminateStaleAgents() {
  for (const container of await docker.listContainers({
    filters: JSON.stringify({ label: ['repellet.managed=true'], network: [config.network] }),
  })) {
    const id = container.Labels['repellet.project'];
    if (id) await killProjectAgent(projectId(id));
  }
}
