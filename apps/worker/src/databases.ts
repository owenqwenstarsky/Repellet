import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { databaseTypeSchema } from '@repellet/shared';
import { docker, BASE_IMAGE } from './images.js';
import { projectId } from './config.js';

export const databaseSpecSchema = z
  .object({
    id: z.string().uuid(),
    type: databaseTypeSchema,
    image: z.enum(['postgres:17-alpine', 'mongo:8.0']),
    initialize: z.boolean().default(false),
    adminPassword: z.string().regex(/^[a-f0-9]{64}$/),
    password: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (s) => s.image === (s.type === 'postgresql' ? 'postgres:17-alpine' : 'mongo:8.0'),
    'Database image does not match engine',
  );
export type DatabaseSpec = z.infer<typeof databaseSpecSchema>;
export const databaseContainer = (id: string) => `repellet-database-${projectId(id)}`;
export const databaseNetwork = (id: string) => `repellet-database-${projectId(id)}`;
export const databaseVolume = (id: string) => `repellet-${projectId(id)}-database`;
export const databaseUrl = (id: string, spec: DatabaseSpec) =>
  spec.type === 'postgresql'
    ? `postgresql://workspace:${spec.password}@${databaseContainer(id)}:5432/repellet`
    : `mongodb://workspace:${spec.password}@${databaseContainer(id)}:27017/repellet?authSource=repellet`;

export async function inspectDatabase(id: string) {
  try {
    const state = await docker.getContainer(databaseContainer(id)).inspect();
    if (
      state.Config.Labels?.['repellet.database'] !== 'true' ||
      state.Config.Labels?.['repellet.project'] !== id
    )
      throw new Error('Database container is not managed by this project');
    return state;
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
}
async function execute(id: string, command: string[], input = '', env: string[] = []) {
  const execution = await docker
    .getContainer(databaseContainer(id))
    .exec({ Cmd: command, Env: env, AttachStdin: !!input, AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true, stdin: !!input });
  const output = new PassThrough(),
    errors = new PassThrough();
  docker.modem.demuxStream(stream, output, errors);
  let text = '';
  output.on('data', (chunk) => {
    text = (text + chunk.toString()).slice(0, 4096);
  });
  errors.resume();
  const timeout = setTimeout(
    () => stream.destroy(new Error('Database initialization timed out')),
    10000,
  );
  try {
    const done = new Promise<void>((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    if (input) stream.end(input);
    await done;
    if ((await execution.inspect()).ExitCode !== 0)
      throw new Error('Database initialization is not ready');
    return text;
  } finally {
    clearTimeout(timeout);
    stream.destroy();
  }
}
export async function ensureDatabase(
  id: string,
  input: DatabaseSpec,
  workspaceContainerId: string,
) {
  const spec = databaseSpecSchema.parse(input);
  try {
    try {
      await docker.getNetwork(databaseNetwork(id)).inspect();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
      await docker.createNetwork({
        Name: databaseNetwork(id),
        Internal: true,
        CheckDuplicate: true,
        Labels: { 'repellet.project': id, 'repellet.kind': 'database' },
      });
    }
    try {
      await docker.getVolume(databaseVolume(id)).inspect();
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
      if (!spec.initialize)
        throw new Error(
          'Database volume is missing. Restore it or delete the database before creating a fresh one.',
        );
      await docker.createVolume({
        Name: databaseVolume(id),
        Labels: { 'repellet.project': id, 'repellet.kind': 'database' },
      });
    }
    let current = await inspectDatabase(id);
    if (current && current.Config.Labels?.['repellet.database.id'] !== spec.id)
      throw new Error('Existing database identity differs; finish deleting it first');
    if (!current) {
      try {
        await docker.getImage(spec.image).inspect();
      } catch (e) {
        if ((e as { statusCode?: number }).statusCode !== 404) throw e;
        const stream = await docker.pull(spec.image);
        await new Promise<void>((resolve, reject) =>
          docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
        );
      }
      const postgres = spec.type === 'postgresql';
      const created = await docker.createContainer({
        name: databaseContainer(id),
        Image: spec.image,
        Env: postgres
          ? [
              'POSTGRES_USER=admin',
              `POSTGRES_PASSWORD=${spec.adminPassword}`,
              'POSTGRES_DB=repellet',
            ]
          : [
              'MONGO_INITDB_ROOT_USERNAME=admin',
              `MONGO_INITDB_ROOT_PASSWORD=${spec.adminPassword}`,
            ],
        ...(postgres
          ? {}
          : { Cmd: ['mongod', '--wiredTigerCacheSizeGB', '0.25', '--bind_ip_all'] }),
        Labels: {
          'repellet.project': id,
          'repellet.kind': 'database',
          'repellet.database': 'true',
          'repellet.database.id': spec.id,
        },
        HostConfig: {
          NetworkMode: databaseNetwork(id),
          Memory: 1024 ** 3,
          MemorySwap: 1024 ** 3,
          NanoCpus: 1e9,
          PidsLimit: 256,
          SecurityOpt: ['no-new-privileges:true'],
          Mounts: [
            {
              Type: 'volume',
              Source: databaseVolume(id),
              Target: postgres ? '/var/lib/postgresql/data' : '/data/db',
            },
          ],
          ...(postgres ? {} : { Tmpfs: { '/data/configdb': 'rw,size=64m' } }),
        },
      });
      await created.start();
      current = await created.inspect();
    } else if (!current.State.Running) await docker.getContainer(current.Id).start();
    const workspace = await docker.getContainer(workspaceContainerId).inspect();
    if (!workspace.NetworkSettings.Networks[databaseNetwork(id)])
      await docker.getNetwork(databaseNetwork(id)).connect({ Container: workspaceContainerId });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        if (spec.type === 'postgresql') {
          await execute(id, ['pg_isready', '-h', '127.0.0.1', '-U', 'admin', '-d', 'repellet']);
          await execute(
            id,
            ['psql', '-h', '127.0.0.1', '-U', 'admin', '-d', 'repellet', '-v', 'ON_ERROR_STOP=1'],
            `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='workspace') THEN CREATE ROLE workspace LOGIN; END IF; END $$;\nALTER ROLE workspace PASSWORD '${spec.password}';\nALTER DATABASE repellet OWNER TO workspace;\nALTER SCHEMA public OWNER TO workspace;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\n`,
            [`PGPASSWORD=${spec.adminPassword}`],
          );
        } else {
          await execute(
            id,
            [
              'mongosh',
              '--quiet',
              '--host',
              '127.0.0.1',
              '--eval',
              'db.getSiblingDB("admin").auth("admin", process.env.REPELLET_ADMIN_PASSWORD); const d=db.getSiblingDB("repellet"); if (!d.getUser("workspace")) d.createUser({user:"workspace",pwd:process.env.REPELLET_DATABASE_PASSWORD,roles:[{role:"dbOwner",db:"repellet"}]}); else d.updateUser("workspace",{pwd:process.env.REPELLET_DATABASE_PASSWORD});',
            ],
            '',
            [
              `REPELLET_ADMIN_PASSWORD=${spec.adminPassword}`,
              `REPELLET_DATABASE_PASSWORD=${spec.password}`,
            ],
          );
        }
        ready = true;
        break;
      } catch {
        if (i < 59) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    if (!ready) throw new Error('Database did not become ready');
    return { status: 'ready' as const, url: databaseUrl(id, spec) };
  } catch {
    throw Object.assign(new Error('Database could not start. Retry from the Database tab.'), {
      statusCode: 503,
    });
  }
}
export async function stopDatabase(id: string) {
  const current = await inspectDatabase(id);
  if (current?.State.Running) await docker.getContainer(current.Id).stop({ t: 20 });
}
export async function removeDatabase(id: string) {
  const current = await inspectDatabase(id);
  if (current) await docker.getContainer(current.Id).remove({ force: true, v: true });
  for (const [kind, name] of [
    ['volume', databaseVolume(id)],
    ['network', databaseNetwork(id)],
  ] as const) {
    try {
      if (kind === 'volume') await docker.getVolume(name).remove();
      else {
        const network = docker.getNetwork(name);
        const state = await network.inspect();
        for (const container of Object.keys(state.Containers || {}))
          await network.disconnect({ Container: container, Force: true });
        await network.remove();
      }
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
    }
  }
}
export async function databaseBytes(id: string) {
  try {
    await docker.getVolume(databaseVolume(id)).inspect();
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 404) return 0;
    throw e;
  }
  const helper = await docker.createContainer({
    Image: BASE_IMAGE,
    User: 'root',
    Entrypoint: ['du', '-sb', '/data'],
    Labels: { 'repellet.helper': 'true' },
    HostConfig: {
      NetworkMode: 'none',
      Memory: 64 * 1024 ** 2,
      Mounts: [{ Type: 'volume', Source: databaseVolume(id), Target: '/data', ReadOnly: true }],
    },
  });
  try {
    await helper.start();
    if ((await helper.wait()).StatusCode !== 0)
      throw new Error('Could not measure database storage');
    const logs = await helper.logs({ stdout: true, stderr: false });
    const buffer = logs as unknown as Buffer;
    let text = '';
    for (let offset = 0; offset + 8 <= buffer.length;) {
      const length = buffer.readUInt32BE(offset + 4);
      text += buffer.subarray(offset + 8, offset + 8 + length).toString();
      offset += 8 + length;
    }
    if (!text.trim()) throw new Error('Missing database storage measurement');
    const bytes = Number(text.trim().split(/\s/)[0]);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error('Invalid database storage measurement');
    return bytes;
  } finally {
    await helper.remove({ force: true }).catch(() => {});
  }
}
