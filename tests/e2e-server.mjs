import dotenv from 'dotenv';
import pg from 'pg';
import Docker from 'dockerode';
import { spawn } from 'node:child_process';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
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
const appPort = Number(process.env.REPELLET_E2E_PORT || 3315);
const workerPort = appPort + 1;
const githubPort = appPort + 2;
const network = 'repellet-e2e-' + dbName;
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const provider = await (await import('./fake-responses-provider.mjs')).fakeResponsesProvider();
const fake = await (await import('./fake-github.mjs')).fakeGitHub();
const fakeUrl = await fake.listen({ host: '127.0.0.1', port: githubPort });
Object.assign(process.env, {
  NODE_ENV: 'test',
  GITHUB_TEST_API: fakeUrl,
  GITHUB_TEST_WEB: fakeUrl,
  DATABASE_URL: url.toString(),
  PORT: String(appPort),
  HOST: '127.0.0.1',
  PUBLIC_URL: `http://localhost:${appPort}`,
  WORKER_PORT: String(workerPort),
  WORKER_URL: `http://127.0.0.1:${workerPort}`,
  INTERNAL_APP_URL: `http://127.0.0.1:${appPort}`,
  PREVIEW_PORT_RANGE: process.env.REPELLET_E2E_PREVIEW_RANGE || '41050-41057',
  DOCKER_NETWORK: network,
  AGENT_ACCOUNTS_HOME: new URL('../.cache/e2e-agent-accounts/', import.meta.url).pathname,
  WORKER_TOKEN: randomBytes(32).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  WORKER_IN_DOCKER: 'false',
});
try {
  await docker.createNetwork({
    Name: network,
    Labels: { 'repellet.e2e': dbName },
    ...(process.env.REPELLET_E2E_SUBNET
      ? { IPAM: { Config: [{ Subnet: process.env.REPELLET_E2E_SUBNET }] } }
      : {}),
  });
} catch (error) {
  await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end();
  await fake.close();
  await provider.close();
  throw error;
}
const { db, migrate, pool } = await import('../apps/api/dist/db.js');
const { installation, githubConfig } = await import('../apps/api/dist/schema.js');
const { encrypt } = await import('../apps/api/dist/security.js');
await migrate();
await db.insert(installation).values({
  id: 1,
  setupToken: encrypt('repellet-e2e-setup-token'),
  limits: { cpu: 2, memoryMb: 2048, storageMb: 5120, maxActiveProjects: 3, idleMinutes: 30 },
});
const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
await db.insert(githubConfig).values({
  id: 1,
  encrypted: encrypt(
    JSON.stringify({
      appId: 123,
      slug: 'repellet-browser-test',
      clientId: 'fake-client',
      clientSecret: 'fake-secret',
      privateKey,
    }),
  ),
});
await pool.end();
await mkdir('.cache', { recursive: true });
await writeFile(
  '.cache/e2e.json',
  JSON.stringify({
    database: dbName,
    url: `http://localhost:${appPort}`,
    providerUrl: provider.url,
  }),
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
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    const { rows } = await client.query('SELECT id FROM projects');
    await fetch(`http://127.0.0.1:${appPort}/internal/maintenance`, {
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
      for (const kind of ['files', 'home', 'agent'])
        await docker
          .getVolume('repellet-' + row.id + '-' + kind)
          .remove()
          .catch(() => {});
    }
  } catch (e) {
    console.error('E2E cleanup:', e.message);
  } finally {
    await docker
      .getNetwork(network)
      .remove()
      .catch(() => {});
    await client.end();
    app.kill('SIGTERM');
    worker.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
    await fake.close();
    await provider.close();
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
