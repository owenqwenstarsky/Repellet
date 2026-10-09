import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, projectId } from '../config.js';
import { docker } from '../images.js';
import {
  withAccount,
  userId,
  publicSettings,
  privateSettings,
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
} from './projects.js';
import { killProjectAgent } from './process.js';
export async function agentRoutes(app: FastifyInstance) {
  const userFrom = (req: { params: unknown }) => userId((req.params as { userId: string }).userId);
  app.get('/agent/users/:userId/settings', async (req) =>
    publicSettings(await privateSettings(userFrom(req))),
  );
  app.put('/agent/users/:userId/settings', async (req) =>
    withAccount(userFrom(req), async () => {
      const settings = await saveSettings(userFrom(req), req.body);
      await closeUserAgents(userFrom(req));
      return settings;
    }),
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
