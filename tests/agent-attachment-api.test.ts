import Fastify from 'fastify';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MAX_AGENT_IMAGE_BYTES } from '@repellet/shared';
const state = vi.hoisted(() => ({ owner: 'owner', stopped: false }));
vi.mock('../apps/api/src/db.js', () => ({ db: {} }));
vi.mock('../apps/api/src/schema.js', () => ({ projects: {} }));
vi.mock('../apps/api/src/config.js', () => ({
  config: { workerUrl: 'http://test', workerToken: 'test' },
}));
vi.mock('../apps/api/src/live.js', () => ({ track: vi.fn() }));
vi.mock('../apps/api/src/collaboration.js', () => ({ flushProject: vi.fn() }));
vi.mock('../apps/api/src/lifecycle.js', () => ({
  serialize: (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('../apps/api/src/security.js', () => ({
  SESSION_COOKIE: 'test',
  requireUser: async (req: any) => {
    if (!req.headers['x-user']) throw Object.assign(new Error('Sign in'), { statusCode: 401 });
    return { id: req.headers['x-user'] };
  },
  projectAgentAccess: vi.fn(async (user, _id, running = true) => {
    if (user.id !== state.owner)
      throw Object.assign(new Error('Owner required'), { statusCode: 403 });
    if (running && state.stopped) throw Object.assign(new Error('Stopped'), { statusCode: 409 });
  }),
}));
vi.mock('../apps/api/src/worker.js', () => ({
  workerJson: vi.fn(async () => ({ id: 'uploaded' })),
  workerRequest: vi.fn(
    async () =>
      new Response('original', {
        headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment' },
      }),
  ),
}));
import { agentRoutes } from '../apps/api/src/agent.js';
import { projectAgentAccess } from '../apps/api/src/security.js';
import { workerJson, workerRequest } from '../apps/api/src/worker.js';
let app: ReturnType<typeof Fastify>;
const project = randomUUID(),
  attachment = randomUUID();
const upload = `/api/projects/${project}/agent/attachments?name=file.txt&mimeType=text%2Fplain`;
beforeEach(async () => {
  vi.clearAllMocks();
  state.stopped = false;
  app = Fastify({ logger: false });
  await app.register(agentRoutes);
});
afterEach(async () => {
  await app.close();
});
it('requires owner access before reading upload bodies and proxies raw bytes', async () => {
  for (const [user, status] of [
    [undefined, 401],
    ['editor', 403],
    ['admin', 403],
    ['owner', 200],
  ] as const) {
    const result = await app.inject({
      method: 'POST',
      url: upload,
      headers: { 'content-type': 'application/octet-stream', ...(user ? { 'x-user': user } : {}) },
      payload: Buffer.from('text'),
    });
    expect(result.statusCode).toBe(status);
  }
  expect(workerJson).toHaveBeenCalledTimes(1);
  expect(workerJson).toHaveBeenCalledWith(
    `/projects/${project}/agent/attachments?name=file.txt&mimeType=text%2Fplain`,
    'POST',
    Buffer.from('text'),
  );
});
it('caps raw upload size without raising the global JSON body limit', async () => {
  const result = await app.inject({
    method: 'POST',
    url: upload,
    headers: { 'content-type': 'application/octet-stream', 'x-user': 'owner' },
    payload: Buffer.alloc(MAX_AGENT_IMAGE_BYTES + 1),
  });
  expect(result.statusCode).toBe(413);
  expect(workerJson).not.toHaveBeenCalled();
});
it('serves authenticated downloads when stopped and validates attachment IDs', async () => {
  state.stopped = true;
  const url = `/api/projects/${project}/agent/attachments/${attachment}`;
  const denied = await app.inject({ method: 'GET', url, headers: { 'x-user': 'editor' } });
  expect(denied.statusCode).toBe(403);
  expect(workerRequest).not.toHaveBeenCalled();
  const result = await app.inject({ method: 'GET', url, headers: { 'x-user': 'owner' } });
  expect(result.statusCode).toBe(200);
  expect(result.body).toBe('original');
  expect(result.headers['content-disposition']).toBe('attachment');
  expect(projectAgentAccess).toHaveBeenLastCalledWith({ id: 'owner' }, project, false);
  const refused = await app.inject({
    method: 'POST',
    url: upload,
    headers: { 'x-user': 'owner', 'content-type': 'application/octet-stream' },
    payload: 'x',
  });
  expect(refused.statusCode).toBe(409);
});
