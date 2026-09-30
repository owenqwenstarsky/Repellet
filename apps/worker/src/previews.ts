import http from 'node:http';
import httpProxy from 'http-proxy';
import type { Socket } from 'node:net';
import { config } from './config.js';
import { inspect, containerName } from './workspaces.js';

type Preview = { server: http.Server; project: string; targetPort: number };
const previews = new Map<number, Preview>();
const activeSockets = new Map<Socket, { userId: string; projectId: string }>();
export function revokePreview(userId: string, projectId?: string) {
  for (const [socket, identity] of activeSockets)
    if (identity.userId === userId && (!projectId || identity.projectId === projectId))
      socket.destroy();
}
function remember(socket: Socket, identity: { userId: string }, projectId: string) {
  activeSockets.set(socket, { userId: identity.userId, projectId });
  socket.once('close', () => activeSockets.delete(socket));
}
async function allowed(request: http.IncomingMessage, id: string) {
  try {
    const response = await fetch(`${config.appUrl}/internal/authorize-preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: id, cookie: request.headers.cookie || '' }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? ((await response.json()) as { userId: string }) : null;
  } catch {
    return null;
  }
}
async function target(id: string, port: number) {
  const state = await inspect(id);
  if (!state?.State.Running) throw new Error('Workspace is stopped');
  if (config.inDocker) return `http://${containerName(id)}:${port}`;
  const binding = state.NetworkSettings.Ports[`${port}/tcp`]?.[0];
  if (!binding) throw new Error('Restart the workspace after changing its preview port');
  return `http://127.0.0.1:${binding.HostPort}`;
}
function cleanCookies(req: http.IncomingMessage) {
  delete req.headers.authorization;
  delete req.headers['x-worker-token'];
  req.headers.cookie = (req.headers.cookie || '')
    .split(';')
    .filter((c) => !c.trim().startsWith('repellet_session='))
    .join(';');
  if (!req.headers.cookie.trim()) delete req.headers.cookie;
}
function sanitizeResponse(response: http.IncomingMessage) {
  const cookies = response.headers['set-cookie'];
  if (cookies)
    response.headers['set-cookie'] = cookies.filter((c) => !/^\s*repellet_session\s*=/i.test(c));
  delete response.headers['clear-site-data'];
}
export function listPreviews() {
  return [...previews.entries()].map(([port, p]) => ({
    projectId: p.project,
    port,
    targetPort: p.targetPort,
  }));
}
export async function enablePreview(id: string, targetPort: number, requested?: number | null) {
  const existing = [...previews.entries()].find(([, p]) => p.project === id);
  if (existing && existing[1].targetPort === targetPort) return existing[0];
  if (existing) await disablePreview(id);
  const [start, end] = config.portRange as [number, number];
  const port =
    requested && requested >= start && requested <= end && !previews.has(requested)
      ? requested
      : Array.from({ length: end - start + 1 }, (_, i) => start + i).find((p) => !previews.has(p));
  if (!port)
    throw Object.assign(
      new Error('No preview ports available; stop another workspace or expand PREVIEW_PORT_RANGE'),
      { statusCode: 409 },
    );
  const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false });
  proxy.on('proxyRes', (proxyRes) => {
    sanitizeResponse(proxyRes);
    delete proxyRes.headers['x-frame-options'];
    proxyRes.headers['content-security-policy'] =
      `frame-ancestors ${new URL(config.publicUrl).origin} ${(process.env.ADDITIONAL_ORIGINS || '').split(',').filter(Boolean).join(' ')}`;
  });
  proxy.on('proxyReqWs', (request) => {
    request.on('upgrade', sanitizeResponse);
    request.on('response', sanitizeResponse);
  });
  proxy.on('error', (_error, _req, res) => {
    if (res instanceof http.ServerResponse && !res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><body style="background:#141619;color:#bfc4cb;font:14px system-ui;padding:32px"><h2>Waiting for your app</h2><p>Start the project’s run command and make sure the server listens on <code>0.0.0.0</code> at the configured preview port.</p></body></html>',
      );
    } else if ('destroy' in res) res.destroy();
  });
  const server = http.createServer(async (req, res) => {
    const identity = await allowed(req, id);
    if (!identity) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Sign in to Repellet with a project member account to view this preview.');
      return;
    }
    remember(req.socket, identity, id);
    try {
      cleanCookies(req);
      const destination = await target(id, targetPort);
      proxy.web(req, res, { target: destination, ignorePath: false });
    } catch {
      res.writeHead(503);
      res.end('Workspace is stopped');
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    const origins = [
      config.publicUrl,
      ...(process.env.ADDITIONAL_ORIGINS || '').split(',').filter(Boolean),
    ].map((address) => {
      const url = new URL(address);
      url.port = String(port);
      return url.origin;
    });
    if (!req.headers.origin || !origins.includes(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const identity = await allowed(req, id);
    if (!identity) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    remember(socket as Socket, identity, id);
    try {
      cleanCookies(req);
      proxy.ws(req, socket as Socket, head, { target: await target(id, targetPort) });
    } catch {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve());
  });
  previews.set(port, { server, project: id, targetPort });
  return port;
}
export async function disablePreview(id: string) {
  for (const [port, p] of previews)
    if (p.project === id) {
      for (const [socket, identity] of activeSockets)
        if (identity.projectId === id) socket.destroy();
      p.server.closeAllConnections();
      await new Promise<void>((resolve) => p.server.close(() => resolve()));
      previews.delete(port);
    }
}
