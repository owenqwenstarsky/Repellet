import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import Fastify from 'fastify';
import { agentRpcSchema, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_TEXT_BYTES } from '@repellet/shared';

const state = vi.hoisted(() => ({
  volumes: new Map<string, Map<string, Buffer>>(),
  mounts: [] as any[],
  removed: [] as string[],
  workspace: null as any,
  usage: { bytes: 0, exceeded: false, limitBytes: 100 * 1024 * 1024 },
}));
vi.mock('../apps/worker/src/databases.js', () => ({
  databaseBytes: async () => 0,
  removeDatabase: async () => {},
}));
vi.mock('../apps/worker/src/agent/accounts.js', () => ({ closeAccounts: vi.fn() }));
vi.mock('../apps/worker/src/agent/process.js', () => ({ killProjectAgent: vi.fn() }));
vi.mock('../apps/worker/src/agent/projects.js', () => ({
  agentUsage: async () => state.usage,
  closeAllAgents: vi.fn(),
}));
vi.mock('../apps/worker/src/config.js', () => ({
  config: { inDocker: false, network: 'test' },
  projectId: (id: string) => id,
}));
vi.mock('../apps/worker/src/images.js', () => ({
  BASE_IMAGE: 'test-image',
  docker: {
    getContainer: () => ({
      inspect: async () => {
        if (state.workspace) return state.workspace;
        throw { statusCode: 404 };
      },
    }),
    getVolume: (name: string) => ({
      remove: async () => {
        state.removed.push(name);
      },
    }),
    createContainer: async (options: any) => {
      const mount = options.HostConfig.Mounts[0];
      state.mounts.push(mount);
      const files = state.volumes.get(mount.Source) || new Map<string, Buffer>();
      state.volumes.set(mount.Source, files);
      return {
        remove: vi.fn(),
        putArchive: async (stream: Readable) => {
          const extract = tar.extract();
          const done = new Promise<void>((resolve, reject) => {
            extract.on('error', reject);
            extract.on('finish', resolve);
            extract.on('entry', (header, entry, next) => {
              const chunks: Buffer[] = [];
              entry.on('data', (data) => chunks.push(Buffer.from(data as Uint8Array)));
              entry.on('end', () => {
                if (header.type === 'file') files.set(header.name, Buffer.concat(chunks));
                next();
              });
            });
          });
          stream.pipe(extract);
          await done;
        },
        getArchive: async ({ path }: { path: string }) => {
          const name = path.replace('/data/', '');
          const data = files.get(name);
          if (!data) throw { statusCode: 404 };
          const pack = tar.pack();
          pack.entry({ name: name.split('/').at(-1)! }, data);
          pack.finalize();
          return Readable.from(pack);
        },
      };
    },
  },
}));
import {
  storeAttachment,
  readAttachment,
  resolveAttachmentInputs,
  validateAttachment,
} from '../apps/worker/src/agent/attachments.js';
import { removeWorkspace } from '../apps/worker/src/workspaces.js';
import { agentRoutes } from '../apps/worker/src/agent/routes.js';

beforeEach(() => {
  state.volumes.clear();
  state.mounts.length = 0;
  state.removed.length = 0;
  state.workspace = null;
  state.usage = { bytes: 0, exceeded: false, limitBytes: 100 * 1024 * 1024 };
});
const project = randomUUID();
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
it('keeps originals and metadata in the project attachment volume and resolves only that project', async () => {
  const image = await storeAttachment(project, { name: 'shot.png', mimeType: 'image/png' }, png);
  const pasted = await storeAttachment(
    project,
    { name: 'pasted-text.txt', mimeType: 'text/plain', label: 'Pasted text' },
    Buffer.from('hello'),
  );
  expect(
    state.mounts.every(
      (mount) => mount.Source === `repellet-${project}-attachments` && mount.Target === '/data',
    ),
  ).toBe(true);
  expect((await readAttachment(project, image.id, true)).data).toEqual(png);
  expect((await readAttachment(project, pasted.id)).meta).toMatchObject({
    label: 'Pasted text',
    bytes: 5,
    kind: 'text',
  });
  expect(
    await resolveAttachmentInputs(project, [
      { type: 'attachment', attachmentId: image.id, kind: 'image' },
    ]),
  ).toEqual([{ type: 'attachment', attachment: image }]);
  await expect(
    resolveAttachmentInputs(randomUUID(), [
      { type: 'attachment', attachmentId: image.id, kind: 'image' },
    ]),
  ).rejects.toThrow('not found');
  await expect(
    resolveAttachmentInputs(project, [
      { type: 'attachment', attachmentId: image.id, kind: 'text' },
    ]),
  ).rejects.toThrow('does not match');
  await expect(readAttachment(project, '../metadata.json')).rejects.toThrow();
});
it('checks image signatures, UTF-8 text, names, types and independent size limits', () => {
  expect(validateAttachment({ name: 'shot.png', mimeType: 'image/png' }, png).kind).toBe('image');
  expect(
    validateAttachment({ name: 'data.json', mimeType: 'application/json' }, Buffer.from('{}')).kind,
  ).toBe('text');
  expect(() => validateAttachment({ name: '../shot.png', mimeType: 'image/png' }, png)).toThrow();
  expect(() => validateAttachment({ name: 'shot.jpg', mimeType: 'image/jpeg' }, png)).toThrow(
    'declared type',
  );
  expect(() =>
    validateAttachment({ name: 'x.svg', mimeType: 'image/svg+xml' }, Buffer.from('<svg/>')),
  ).toThrow('Unsupported');
  expect(() =>
    validateAttachment({ name: 'x.txt', mimeType: 'text/plain' }, Buffer.from([0xff])),
  ).toThrow('UTF-8');
  expect(() =>
    validateAttachment({ name: 'x.txt', mimeType: 'text/plain' }, Buffer.from([0])),
  ).toThrow('UTF-8');
  expect(() =>
    validateAttachment(
      { name: 'x.txt', mimeType: 'text/plain' },
      Buffer.alloc(MAX_AGENT_TEXT_BYTES + 1),
    ),
  ).toThrow('1 MiB');
  expect(() =>
    validateAttachment(
      { name: 'x.png', mimeType: 'image/png' },
      Buffer.alloc(MAX_AGENT_IMAGE_BYTES + 1),
    ),
  ).toThrow('20 MiB');
  expect(() =>
    validateAttachment({ name: 'x.txt', mimeType: 'text/plain' }, Buffer.alloc(0)),
  ).toThrow('empty');
});
it('accepts four images plus four text files, including attachment-only turns and steering', () => {
  const refs = (kind: 'image' | 'text', count: number) =>
    Array.from({ length: count }, () => ({ type: 'attachment', attachmentId: randomUUID(), kind }));
  const rpc = (input: any[], method = 'turn/start') =>
    agentRpcSchema.safeParse({
      generation: randomUUID(),
      method,
      params: {
        threadId: 'thread',
        input,
        ...(method === 'turn/steer' ? { expectedTurnId: 'turn' } : {}),
      },
    });
  expect(rpc([...refs('image', 4), ...refs('text', 4)]).success).toBe(true);
  expect(rpc(refs('image', 1), 'turn/steer').success).toBe(true);
  expect(rpc(refs('image', 5)).success).toBe(false);
  expect(rpc(refs('text', 5)).success).toBe(false);
  const ref = refs('text', 1)[0];
  expect(rpc([ref, ref]).success).toBe(false);
  expect(rpc([{ type: 'attachment', attachmentId: '../data', kind: 'image' }]).success).toBe(false);
  expect(
    rpc([{ type: 'attachment', attachmentId: randomUUID(), kind: 'image', path: '/other-project' }])
      .success,
  ).toBe(false);
});
it('removes the attachment volume together with project files and private history', async () => {
  await removeWorkspace(project);
  expect(state.removed).toEqual(
    ['files', 'home', 'agent', 'attachments'].map((kind) => `repellet-${project}-${kind}`),
  );
});

it('checks workspace compatibility and available project storage before persisting uploads', async () => {
  const app = Fastify({ logger: false });
  await app.register(agentRoutes);
  const upload = () =>
    app.inject({
      method: 'POST',
      url: `/projects/${project}/agent/attachments?name=notes.txt&mimeType=text%2Fplain`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('notes'),
    });
  try {
    expect((await upload()).statusCode).toBe(409);
    expect(state.volumes.size).toBe(0);
    state.workspace = {
      State: { Running: true },
      Mounts: [{ Destination: '/home/agent/attachments' }],
    };
    state.usage.limitBytes = 4;
    expect((await upload()).statusCode).toBe(507);
    expect(state.volumes.size).toBe(0);
    state.usage.limitBytes = 1024;
    const result = await upload();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ kind: 'text', bytes: 5, name: 'notes.txt' });
    const downloaded = await app.inject({
      method: 'GET',
      url: `/projects/${project}/agent/attachments/${result.json().id}`,
    });
    expect(downloaded.body).toBe('notes');
    expect(downloaded.headers['content-type']).toBe('text/plain');
    expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
  } finally {
    await app.close();
  }
});
