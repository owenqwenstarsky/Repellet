import { it, expect, beforeAll, afterAll, describe } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { createBackup, verifyBackup, restoreBackup } from '../scripts/lib/backup.mjs';
import { runDocker } from '../scripts/lib/docker.mjs';
dotenv.config({ quiet: true });
it('rejects a corrupted backup before calling any restore operation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'repellet-backup-corrupt-'));
  try {
    await rm(directory, { recursive: true });
    const envFile = directory + '-env';
    await writeFile(envFile, 'ENCRYPTION_KEY=test\n');
    await createBackup({
      destination: directory,
      envFile,
      volumes: [],
      dump: (file) => writeFile(file, 'dump'),
      archiveVolume: async () => {},
    });
    await writeFile(path.join(directory, 'database.dump'), 'corrupted');
    let called = false;
    await expect(
      restoreBackup({
        directory,
        restoreDatabase: async () => {
          called = true;
        },
        restoreVolume: async () => {
          called = true;
        },
        restoreEnvironment: async () => {
          called = true;
        },
      }),
    ).rejects.toThrow('checksum');
    expect(called).toBe(false);
    await rm(envFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const enabled = process.env.RUN_DOCKER_TESTS === '1' && !!process.env.DATABASE_URL;
describe.skipIf(!enabled)('backup restoration with PostgreSQL and Docker volumes', () => {
  const suffix = randomBytes(6).toString('hex');
  const source = 'repellet_backup_' + suffix,
    target = 'repellet_restore_' + suffix;
  const id = randomUUID();
  const volumes = [`repellet-${id}-files`, `repellet-${id}-home`];
  let admin: pg.Client, client: pg.Client, temp: string, databaseContainer: string;
  let security: typeof import('../apps/api/src/security.js');
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${source}`);
    await admin.query(`CREATE DATABASE ${target}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + source;
    process.env.DATABASE_URL = url.toString();
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
    security = await import('../apps/api/src/security.js');
    const database = await import('../apps/api/src/db.js');
    await database.migrate();
    await database.pool.end();
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    databaseContainer = await runDocker(['compose', 'ps', '-q', 'database'], { capture: true });
    if (!databaseContainer) throw new Error('Development database container is required');
    temp = await mkdtemp(path.join(os.tmpdir(), 'repellet-backup-test-'));
    for (const volume of volumes) await runDocker(['volume', 'create', volume], { capture: true });
  });
  afterAll(async () => {
    await client?.end();
    for (const volume of volumes)
      await runDocker(['volume', 'rm', '-f', volume], { capture: true }).catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${source} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
      await admin.end();
    }
    if (temp) await rm(temp, { recursive: true, force: true });
  });
  it('recovers accounts, project metadata, encrypted secrets, files, and home configuration', async () => {
    const hash = await security.hashPassword('restore-test-password-123');
    const owner = randomUUID();
    await client.query(
      'INSERT INTO users(id,username,display_name,password_hash,is_owner) VALUES($1,$2,$3,$4,true)',
      [owner, 'restored-owner', 'Restored Owner', hash],
    );
    await client.query(
      'INSERT INTO projects(id,owner_id,name,runtimes,run_config,environment) VALUES($1,$2,$3,$4,$5,$6)',
      [
        id,
        owner,
        'Restored project',
        JSON.stringify(['python', 'node']),
        JSON.stringify({ command: 'python main.py', cwd: '', port: 8000 }),
        security.encrypt(JSON.stringify({ RESTORED_SECRET: 'private-value' })),
      ],
    );
    const helper = (volume: string, command: string, options: any = {}) =>
      runDocker(
        [
          'run',
          '--rm',
          ...(options.input ? ['-i'] : []),
          '--network',
          'none',
          '--mount',
          `type=volume,source=${volume},target=/data`,
          'debian:bookworm-slim',
          'sh',
          '-c',
          command,
        ],
        options,
      );
    await helper(volumes[0]!, "printf 'print(42)\\n' > /data/main.py");
    await helper(
      volumes[1]!,
      "mkdir -p /data/.ssh; printf 'private config' > /data/.ssh/config; chmod 600 /data/.ssh/config",
    );
    const envFile = path.join(temp, 'installation.env');
    await writeFile(envFile, `ENCRYPTION_KEY=${process.env.ENCRYPTION_KEY}\n`, { mode: 0o600 });
    const directory = path.join(temp, 'snapshot');
    await createBackup({
      destination: directory,
      envFile,
      volumes,
      dump: (file) =>
        runDocker(['exec', databaseContainer, 'pg_dump', '-U', 'repellet', '-d', source, '-Fc'], {
          output: file,
        }),
      archiveVolume: (volume, file) => helper(volume, 'tar -czpf - -C /data .', { output: file }),
    });
    expect((await verifyBackup(directory)).volumes).toHaveLength(2);
    for (const volume of volumes)
      await helper(volume, 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +');
    let restoredKey = '';
    await restoreBackup({
      directory,
      restoreEnvironment: async (content) => {
        restoredKey = dotenv.parse(content).ENCRYPTION_KEY!;
      },
      restoreDatabase: (file) =>
        runDocker(
          [
            'exec',
            '-i',
            databaseContainer,
            'pg_restore',
            '-U',
            'repellet',
            '-d',
            target,
            '--exit-on-error',
            '--no-owner',
          ],
          { input: file },
        ),
      restoreVolume: (volume, file) => helper(volume, 'tar -xzpf - -C /data', { input: file }),
    });
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + target;
    const restored = new pg.Client({ connectionString: url.toString() });
    await restored.connect();
    try {
      const { rows } = await restored.query(
        'SELECT u.password_hash,p.name,p.environment FROM users u JOIN projects p ON p.owner_id=u.id',
      );
      expect(rows[0].name).toBe('Restored project');
      expect(
        await security.verifyPassword(rows[0].password_hash, 'restore-test-password-123'),
      ).toBe(true);
      expect(JSON.parse(security.decrypt(rows[0].environment, restoredKey))).toEqual({
        RESTORED_SECRET: 'private-value',
      });
    } finally {
      await restored.end();
    }
    expect(await helper(volumes[0]!, 'cat /data/main.py', { capture: true })).toBe('print(42)');
    expect(
      await helper(volumes[1]!, 'cat /data/.ssh/config; stat -c %a /data/.ssh/config', {
        capture: true,
      }),
    ).toBe('private config600');
  }, 120000);
});
