import { it, expect } from 'vitest';
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
it.skipIf(!process.env.DATABASE_URL)(
  'upgrades existing projects and durable documents without rewriting identities or private state',
  async () => {
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const name = 'repellet_migration_' + randomBytes(5).toString('hex');
    const temp = await mkdtemp(path.join(os.tmpdir(), 'repellet-migrations-'));
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + name;
    process.env.DATABASE_URL = url.toString();
    process.env.ENCRYPTION_KEY ||= '11'.repeat(32);
    process.env.WORKER_TOKEN ||= 'test-worker-token-'.repeat(4);
    const { config } = await import('../apps/api/src/config.js');
    const database = await import('../apps/api/src/db.js');
    const current = config.migrationDir;
    try {
      for (const file of (await readdir(current)).filter((name) => name < '0005'))
        await copyFile(path.join(current, file), path.join(temp, file));
      config.migrationDir = temp;
      await database.migrate();
      const owner = randomUUID(),
        project = randomUUID(),
        doc = randomUUID();
      await database.pool.query(
        'INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$3,$4)',
        [owner, 'owner', 'Owner', 'hash'],
      );
      await database.pool.query(
        'INSERT INTO projects(id,owner_id,name,runtimes,run_config,environment) VALUES($1,$2,$3,$4,$5,$6)',
        [
          project,
          owner,
          'Migrated',
          JSON.stringify(['node']),
          JSON.stringify({ command: 'npm start', cwd: 'app', port: 3333 }),
          'encrypted-preserved',
        ],
      );
      await database.pool.query(
        'INSERT INTO documents(id,project_id,path,state,dirty,disk_hash) VALUES($1,$2,$3,$4,true,$5)',
        [doc, project, 'app/main.ts', 'durable-yjs-state', 'disk-hash'],
      );
      config.migrationDir = current;
      await database.migrate();
      const profiles = (
        await database.pool.query('SELECT * FROM project_run_profiles WHERE project_id=$1', [
          project,
        ])
      ).rows;
      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({
        name: 'Run',
        command: 'npm start',
        cwd: 'app',
        is_default: true,
      });
      expect(
        (
          await database.pool.query('SELECT * FROM project_preview_targets WHERE project_id=$1', [
            project,
          ])
        ).rows[0],
      ).toMatchObject({ id: profiles[0].preview_target_id, target_port: 3333 });
      expect(
        (await database.pool.query('SELECT * FROM documents WHERE id=$1', [doc])).rows[0],
      ).toMatchObject({
        id: doc,
        state: 'durable-yjs-state',
        disk_hash: 'disk-hash',
        dirty: true,
        revision: '0',
      });
      expect(
        (await database.pool.query('SELECT environment FROM projects WHERE id=$1', [project]))
          .rows[0].environment,
      ).toBe('encrypted-preserved');
      expect(
        (await database.pool.query('SELECT count(*)::int AS n FROM project_agent_policies')).rows[0]
          .n,
      ).toBe(0);
      await database.migrate();
      expect(
        (await database.pool.query('SELECT count(*)::int AS n FROM project_run_profiles')).rows[0]
          .n,
      ).toBe(1);
    } finally {
      config.migrationDir = current;
      await database.pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
