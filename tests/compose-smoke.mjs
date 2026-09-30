// Test only a disposable Compose installation; the caller supplies its unique project and env file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { WebSocket } from 'ws';
import { runDocker } from '../scripts/lib/docker.mjs';
if (
  !process.env.REPELLET_ENV_FILE ||
  !process.env.COMPOSE_PROJECT_NAME?.startsWith('repellet-smoke')
)
  throw new Error(
    'Set REPELLET_ENV_FILE and a disposable COMPOSE_PROJECT_NAME beginning repellet-smoke',
  );
const env = parse(await readFile(process.env.REPELLET_ENV_FILE));
const base = env.PUBLIC_URL;
const compose = ['compose', '--env-file', process.env.REPELLET_ENV_FILE];
let cookie = '';
let project;
async function request(route, method = 'GET', body) {
  const response = await fetch(base + route, {
    method,
    headers: { origin: base, cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
  const cookies = response.headers.getSetCookie();
  if (cookies.some((c) => c.startsWith('repellet_session=')))
    cookie = cookies.find((c) => c.startsWith('repellet_session=')).split(';')[0];
  return response.json();
}
async function poll(fn, description, timeout = 180000) {
  const until = Date.now() + timeout;
  let error;
  while (Date.now() < until) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      if (e.fatal) throw e;
      error = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(description + ': ' + (error?.message || 'timed out'));
}
function operator(command, location, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/backup.mjs', command, location, ...flags], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Operator script failed')),
    );
  });
}
try {
  await poll(async () => {
    const h = await request('/api/health');
    return h.ok && h.worker;
  }, 'Compose health');
  const status = await request('/api/setup/status');
  if (status.required) {
    const logs = await runDocker([...compose, 'logs', '--no-color', 'app'], { capture: true });
    const token = /First-time setup token: ([A-Za-z0-9_-]+)/.exec(logs)?.[1];
    assert(token, 'Setup token emitted');
    await request('/api/setup', 'POST', {
      token,
      username: 'smoke-owner',
      displayName: 'Smoke Owner',
      password: 'compose-smoke-password-123',
    });
  } else
    await request('/api/auth/login', 'POST', {
      username: 'smoke-owner',
      password: 'compose-smoke-password-123',
    });
  project = await request('/api/projects', 'POST', {
    name: 'Compose smoke',
    runtimes: ['python', 'go'],
  });
  await request(`/api/projects/${project.id}`, 'PATCH', {
    runConfig: { command: 'python server.py', cwd: '', port: 8000 },
  });
  await request(`/api/projects/${project.id}/open`, 'POST');
  await poll(
    async () => {
      const p = await request(`/api/projects/${project.id}`);
      if (p.state === 'failed') throw Object.assign(new Error(p.error), { fatal: true });
      return p.state === 'running' && p;
    },
    'Mixed-runtime Compose workspace',
    600000,
  );
  const script = `from http.server import BaseHTTPRequestHandler, HTTPServer\nimport base64, hashlib\nclass Handler(BaseHTTPRequestHandler):\n    def do_GET(self):\n        if self.headers.get('Upgrade', '').lower() == 'websocket':\n            key = self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'\n            self.send_response(101)\n            self.send_header('Upgrade', 'websocket')\n            self.send_header('Connection', 'Upgrade')\n            self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())\n            self.end_headers()\n            self.wfile.write(bytes([129, 9]) + b'HMR_READY')\n            self.wfile.flush()\n            return\n        self.send_response(200)\n        self.send_header('Set-Cookie', 'repellet_session=forbidden; Path=/')\n        self.send_header('Set-Cookie', 'preview_test=ok; Path=/')\n        self.end_headers()\n        self.wfile.write((self.headers.get('Cookie', '<none>') + '|' + self.headers.get('Authorization', '<none>')).encode())\nHTTPServer(('0.0.0.0', 8000), Handler).serve_forever()\n`;
  await request(`/api/projects/${project.id}/files/upload`, 'POST', {
    path: 'server.py',
    data: Buffer.from(script).toString('base64'),
  });
  await request(`/api/projects/${project.id}/environment`, 'PUT', {
    runtimes: ['python', 'go'],
    variables: { RESTORE_TEST: 'encrypted-value' },
  });
  await request(`/api/projects/${project.id}/run`, 'POST');
  const p = await request(`/api/projects/${project.id}`);
  const preview = new URL(base);
  preview.port = String(p.previewPort);
  const response = await poll(async () => {
    const r = await fetch(preview, { headers: { cookie, authorization: 'should-be-stripped' } });
    return r.status === 200 && r;
  }, 'Private preview');
  assert.equal(await response.text(), '<none>|<none>');
  assert(response.headers.getSetCookie().every((c) => !c.startsWith('repellet_session=')));
  assert.equal((await fetch(preview)).status, 403);
  const ws = new WebSocket(preview.toString().replace(/^http/, 'ws'), {
    headers: { cookie, origin: preview.origin },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview WebSocket timed out')), 10000);
    ws.on('message', (data) => {
      clearTimeout(timer);
      assert.equal(String(data), 'HMR_READY');
      resolve();
    });
    ws.on('error', reject);
  });
  ws.terminate();
  // The worker rebuilds preview listeners; the API reconciles live projects after restart.
  await runDocker([...compose, 'restart', 'worker', 'app']);
  await poll(async () => {
    const health = await request('/api/health');
    if (!health.worker) return false;
    const state = await request(`/api/projects/${project.id}`);
    if (state.state !== 'running') return false;
    return (await request(`/api/projects/${project.id}/file?path=server.py`)).content === script;
  }, 'Restart reconciliation');
  const snapshot = '.cache/compose-backup-' + Date.now();
  await operator('backup', snapshot);
  await operator('verify', snapshot);
  await operator('restore', snapshot, ['--confirm=REPLACE']);
  await runDocker([
    ...compose,
    'up',
    '-d',
    '--wait',
    '--force-recreate',
    'database',
    'worker',
    'app',
  ]);
  cookie = '';
  await request('/api/auth/login', 'POST', {
    username: 'smoke-owner',
    password: 'compose-smoke-password-123',
  });
  assert.equal(
    (await request(`/api/projects/${project.id}/environment`)).variables.RESTORE_TEST,
    'encrypted-value',
  );
  await request(`/api/projects/${project.id}/open`, 'POST');
  await poll(
    async () => (await request(`/api/projects/${project.id}`)).state === 'running',
    'Restored workspace',
  );
  assert.equal((await request(`/api/projects/${project.id}/file?path=server.py`)).content, script);
  console.log(
    'Compose smoke passed: setup, in-container image build, workspace, private HTTP/WebSocket preview, credential stripping, restart reconciliation, and operator backup/restore.',
  );
} finally {
  if (project && cookie) await request(`/api/projects/${project.id}`, 'DELETE').catch(() => {});
}
