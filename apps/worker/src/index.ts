import { agentRoutes, terminateStaleAgents } from './agent/routes.js';
import { stopAgent } from './agent/projects.js';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { Readable } from 'node:stream';
import { runtimesSchema, limitsSchema, environmentSchema } from '@repellet/shared';
import { config, authorized, projectId, bridgeToken } from './config.js';
import { docker, buildLog } from './images.js';
import {
  ensureWorkspace,
  prepareWorkspace,
  stopWorkspace,
  removeWorkspace,
  duplicateWorkspace,
  inspect,
  bridgeAddress,
  bridgeRequest,
} from './workspaces.js';
import { enablePreview, disablePreview, listPreviews, revokePreview } from './previews.js';
await terminateStaleAgents();
const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });
await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
app.addHook('onRequest', async (req, reply) => {
  if (!authorized(req.headers.authorization))
    return reply.code(401).send({ error: 'Unauthorized' });
});
app.setErrorHandler((error, req, reply) => {
  const e = error as Error & { statusCode?: number; completedFiles?: string[] };
  req.log.error(e);
  reply
    .code(e.statusCode || 400)
    .send({ error: e.message, ...(e.completedFiles ? { completedFiles: e.completedFiles } : {}) });
});
await agentRoutes(app);
const idFrom = (req: { params: unknown }) => projectId((req.params as { id: string }).id);
app.post('/revoke', async (req) => {
  const b = req.body as { userId: string; projectId?: string };
  revokePreview(b.userId, b.projectId);
  return { ok: true };
});
app.get('/health', async () => {
  await docker.ping();
  return { ok: true };
});
app.get('/projects', async () => {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: ['repellet.managed=true'] }),
  });
  return containers.map((c) => ({
    id: c.Labels['repellet.project'],
    state: c.State,
    status: c.Status,
  }));
});
app.get('/projects/:id', async (req) => {
  const current = await inspect(idFrom(req));
  return {
    running: !!current?.State.Running,
    oomKilled: current?.State.OOMKilled || false,
    exitCode: current?.State.ExitCode || 0,
    exists: !!current,
    previews: listPreviews().filter((p) => p.projectId === idFrom(req)),
  };
});
app.get('/projects/:id/logs', async (req) => ({ log: buildLog(idFrom(req)) }));
app.post('/projects/:id/build', async (req) => {
  const b = req.body as { runtimes: unknown; rebuild?: boolean };
  if (b.rebuild) {
    await stopAgent(idFrom(req));
    await disablePreview(idFrom(req));
  }
  return prepareWorkspace(idFrom(req), runtimesSchema.parse(b.runtimes), b.rebuild === true);
});
app.post('/projects/:id/ensure', async (req) => {
  const b = req.body as Record<string, unknown>;
  if (b.rebuild) await stopAgent(idFrom(req));
  return ensureWorkspace(idFrom(req), {
    runtimes: runtimesSchema.parse(b.runtimes),
    limits: limitsSchema.parse(b.limits),
    environment: environmentSchema.parse(b.environment),
    rebuild: b.rebuild === true,
    prepared: b.prepared === true,
    cloneUrl: typeof b.cloneUrl === 'string' ? b.cloneUrl : undefined,
    previewTargetPort: typeof b.previewTargetPort === 'number' ? b.previewTargetPort : 3000,
  });
});
app.post('/projects/:id/stop', async (req) => {
  await stopAgent(idFrom(req));
  await disablePreview(idFrom(req));
  return stopWorkspace(idFrom(req));
});
app.delete('/projects/:id', async (req) => {
  await stopAgent(idFrom(req));
  await disablePreview(idFrom(req));
  return removeWorkspace(idFrom(req));
});
app.post('/projects/:id/duplicate', async (req) =>
  duplicateWorkspace(idFrom(req), projectId((req.body as { id: string }).id)),
);
app.post('/projects/:id/preview', async (req) => {
  const b = req.body as { targetPort: number; port?: number };
  if (!Number.isInteger(b.targetPort) || b.targetPort < 1024 || b.targetPort > 65535)
    throw new Error('Invalid preview target port');
  return { port: await enablePreview(idFrom(req), b.targetPort, b.port) };
});
app.post('/projects/:id/probe', async (req) => {
  const id = idFrom(req);
  const port = (req.body as { port: number }).port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Invalid preview port');
  const current = await inspect(id);
  if (!current?.State.Running) return { responding: false };
  const host = config.inDocker ? `repellet-project-${id}` : '127.0.0.1';
  const target = config.inDocker
    ? port
    : Number(current.NetworkSettings.Ports[`${port}/tcp`]?.[0]?.HostPort);
  if (!target) return { responding: false };
  try {
    const response = await fetch(`http://${host}:${target}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    return { responding: true, httpStatus: response.status };
  } catch {
    return { responding: false };
  }
});
const allowedPath =
  /^\/(preparation(?:\/[a-z0-9-]+)?|scaffold|fingerprint|inspect|health|files(?:\/(?:create|move|delete|upload))?|file-index|file|search|replace|format|terminals(?:\/[0-9a-z-]+)?|run(?:\/stop)?|environment|agent-usage|limits|usage|git(?:\/(?:status|diff|remote))?|shutdown)(?:\?[^\r\n]*)?$/;
app.post('/projects/:id/request', async (req) => {
  const b = req.body as { path: string; method: string; body?: unknown };
  if (!allowedPath.test(b.path) || !['GET', 'POST', 'PUT', 'DELETE'].includes(b.method))
    throw Object.assign(new Error('Unsupported workspace operation'), { statusCode: 400 });
  const response = await bridgeRequest(idFrom(req), b.path, b.method, b.body);
  return response.json();
});
for (const operation of ['export', 'download'])
  app.get(`/projects/:id/${operation}`, async (req, reply) => {
    const q = req.query as { path: string };
    const route =
      operation === 'export'
        ? '/export'
        : `/files/download?path=${encodeURIComponent(q.path || '')}`;
    const response = await bridgeRequest(idFrom(req), route);
    return reply
      .header('x-repellet-archive', response.headers.get('x-repellet-archive') || 'false')
      .header('content-type', response.headers.get('content-type') || 'application/octet-stream')
      .send(Readable.fromWeb(response.body as never));
  });
app.get('/projects/:id/ws', { websocket: true }, async (client, req) => {
  const id = idFrom(req);
  const p = String((req.query as { path: string }).path || '');
  if (!/^\/(events|terminals\/[a-z0-9-]+\/connect|language\/(python|node|go|rust))$/.test(p)) {
    client.close(1008, 'Unsupported channel');
    return;
  }
  try {
    const destination = (await bridgeAddress(id)).replace(/^http/, 'ws') + p;
    const upstream = new WebSocket(destination, {
      headers: { authorization: `Bearer ${bridgeToken(id)}` },
      maxPayload: 4 * 1024 * 1024,
    });
    const pending: Buffer[] = [];
    client.on('message', (data, isBinary) => {
      if (upstream.readyState === 1) upstream.send(data, { binary: isBinary });
      else if (pending.length < 30) pending.push(Buffer.from(data as Buffer));
    });
    upstream.on('open', () => {
      for (const item of pending) upstream.send(item);
    });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === 1) client.send(data, { binary: isBinary });
    });
    upstream.on('error', () => client.close(1011, 'Workspace channel unavailable'));
    upstream.on('close', () => client.close());
    client.on('close', () => upstream.close());
  } catch (e) {
    client.close(1011, (e as Error).message.slice(0, 120));
  }
});
await app.listen({ host: config.inDocker ? '0.0.0.0' : '127.0.0.1', port: config.port });

for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
