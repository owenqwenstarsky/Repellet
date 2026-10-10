import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../apps/api/src/security.js', () => ({
  SESSION_COOKIE: 'session',
  requireUser: async (req: any) => {
    if (!req.headers.role) throw Object.assign(new Error('Sign in'), { statusCode: 401 });
    return { id: 'authenticated-user', isOwner: req.headers.role === 'admin' };
  },
  requireOwner: async (req: any) => {
    if (req.headers.role !== 'admin')
      throw Object.assign(new Error('Administrator required'), { statusCode: 403 });
    return { id: 'admin' };
  },
  projectAgentAccess: vi.fn(),
}));
vi.mock('../apps/api/src/worker.js', () => ({
  workerJson: async (route: string, method: string, body: any) => {
    state.calls.push({ route, method, body });
    return { ok: true };
  },
  workerRequest: vi.fn(),
}));
vi.mock('../apps/api/src/db.js', () => ({ db: {} }));
vi.mock('../apps/api/src/schema.js', () => ({ projects: {} }));
vi.mock('../apps/api/src/collaboration.js', () => ({ flushProject: vi.fn() }));
vi.mock('../apps/api/src/lifecycle.js', () => ({ serialize: vi.fn() }));
vi.mock('../apps/api/src/live.js', () => ({ track: vi.fn() }));
vi.mock('../apps/api/src/config.js', () => ({ config: {} }));
import { agentRoutes } from '../apps/api/src/agent.js';
beforeEach(() => {
  state.calls.length = 0;
});
async function request(options: any) {
  const app = Fastify();
  await app.register(websocket);
  await agentRoutes(app);
  try {
    return await app.inject(options);
  } finally {
    await app.close();
  }
}
it.each(['GET', 'PUT', 'POST'])(
  'requires administrator authorization for global %s operations before forwarding',
  async (method) => {
    const url = method === 'POST' ? '/api/admin/agent-api/models' : '/api/admin/agent-api';
    const body = method === 'GET' ? {} : { payload: {} };
    const denied = await request({ method, url, headers: { role: 'member' }, ...body });
    expect(denied.statusCode).toBe(403);
    expect(state.calls).toEqual([]);
    const payload =
      method === 'POST'
        ? { baseUrl: 'https://proxy.invalid/v1', apiKey: 'key' }
        : {
            enabled: true,
            baseUrl: 'https://proxy.invalid/v1',
            allowedModels: ['model'],
            apiKey: 'key',
          };
    const allowed = await request({
      method,
      url,
      headers: { role: 'admin' },
      ...(method === 'GET' ? {} : { payload }),
    });
    expect(allowed.statusCode).toBe(200);
    expect(state.calls[0].route).toBe(method === 'POST' ? '/agent/global/models' : '/agent/global');
  },
);
it('requires a signed-in user for catalogs and binds requests to that user', async () => {
  expect(
    (await request({ method: 'GET', url: '/api/agent/models?api=cliproxyapi' })).statusCode,
  ).toBe(401);
  expect(state.calls).toEqual([]);
  expect(
    (
      await request({
        method: 'GET',
        url: '/api/agent/models?api=cliproxyapi&refresh=true',
        headers: { role: 'member' },
      })
    ).statusCode,
  ).toBe(200);
  expect(state.calls[0].route).toBe(
    '/agent/users/authenticated-user/models?api=cliproxyapi&refresh=true',
  );
  state.calls.length = 0;
  expect(
    (
      await request({
        method: 'GET',
        url: '/api/agent/models?api=cliproxyapi&userId=someone',
        headers: { role: 'member' },
      })
    ).statusCode,
  ).toBe(500);
  expect(state.calls).toEqual([]);
});
