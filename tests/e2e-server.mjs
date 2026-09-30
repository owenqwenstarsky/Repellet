import dotenv from 'dotenv';
import pg from 'pg';
import Docker from 'dockerode';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
dotenv.config({ quiet: true });
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error('Start the development database before browser tests.');
const dbName = 'repellet_e2e_' + randomBytes(6).toString('hex');
const admin = new pg.Client({ connectionString: baseUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`);
const url = new URL(baseUrl);
url.pathname = '/' + dbName;
Object.assign(process.env, {
  DATABASE_URL: url.toString(),
  PORT: '3315',
  HOST: '127.0.0.1',
  PUBLIC_URL: 'http://localhost:3315',
  WORKER_PORT: '3316',
  WORKER_URL: 'http://127.0.0.1:3316',
  INTERNAL_APP_URL: 'http://127.0.0.1:3315',
  PREVIEW_PORT_RANGE: '41050-41057',
  DOCKER_NETWORK: 'repellet-e2e-workspaces',
  WORKER_TOKEN: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  WORKER_IN_DOCKER: 'false',
});
const { db, migrate, pool } = await import('../apps/api/dist/db.js');
const { installation } = await import('../apps/api/dist/schema.js');
const { encrypt } = await import('../apps/api/dist/security.js');
await migrate();
await db.insert(installation).values({
  id: 1,
  setupToken: encrypt('repellet-e2e-setup-token'),
  limits: { cpu: 2, memoryMb: 2048, storageMb: 5120, maxActiveProjects: 3, idleMinutes: 30 },
});
await pool.end();
await mkdir('.cache', { recursive: true });
await writeFile(
  '.cache/e2e.json',
  JSON.stringify({ database: dbName, url: 'http://localhost:3315' }),
);
const worker = spawn(process.execPath, ['apps/worker/dist/index.js'], {
  stdio: 'inherit',
  env: process.env,
});
const app = spawn(process.execPath, ['apps/api/dist/index.js'], {
  stdio: 'inherit',
  env: process.env,
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT id FROM projects');
    await fetch('http://127.0.0.1:3315/internal/maintenance', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + process.env.WORKER_TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {});
    app.kill('SIGTERM');
    worker.kill('SIGTERM');
    for (const row of rows) {
      await docker
        .getContainer('repellet-project-' + row.id)
        .remove({ force: true })
        .catch(() => {});
      for (const kind of ['files', 'home'])
        await docker
          .getVolume('repellet-' + row.id + '-' + kind)
          .remove()
          .catch(() => {});
    }
  } catch (e) {
    console.error('E2E cleanup:', e.message);
  } finally {
    await client.end();
    app.kill('SIGTERM');
    worker.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
    process.exit(0);
  }
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
app.on('exit', (code) => {
  if (!shuttingDown) {
    console.error('E2E app exited', code);
    void shutdown();
  }
});
worker.on('exit', (code) => {
  if (!shuttingDown) {
    console.error('E2E worker exited', code);
    void shutdown();
  }
});
