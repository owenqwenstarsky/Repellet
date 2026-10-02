import { beforeEach, afterEach, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createStaticServer } from '../packages/bridge/src/static-server.js';
import type { FastifyInstance } from 'fastify';

let directory: string, root: string, app: FastifyInstance;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'repellet-static-'));
  root = path.join(directory, 'site');
  await fs.mkdir(path.join(root, 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'empty'));
  await fs.mkdir(path.join(root, '.git'));
  for (const [file, content] of Object.entries({
    'index.html': '<html><body><h1>Static page</h1></body></html>',
    'nested/index.html': '<h1>Nested page</h1>',
    'style.css': 'body { color: red; }',
    'script.js': 'export const value = 1;',
    'module.mjs': 'export default 1;',
    'image.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'font.woff2': 'font',
    'space name.txt': 'spaces',
    '.env': 'SECRET=hidden',
    '.git/config': 'hidden git config',
  }))
    await fs.writeFile(path.join(root, file), content);
  await fs.writeFile(path.join(directory, 'outside.txt'), 'outside');
  await fs.symlink(directory, path.join(root, 'escape'));
  await fs.symlink(path.join(root, '.env'), path.join(root, 'hidden.txt'));
  await fs.symlink(path.join(root, 'style.css'), path.join(root, 'linked.css'));
  app = await createStaticServer(root);
});
afterEach(async () => {
  await app?.close();
  await fs.rm(directory, { recursive: true, force: true });
});

it('serves and injects HTML without modifying files, including directory index pages', async () => {
  const page = await app.inject('/');
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-type']).toContain('text/html');
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.body).toContain('/__repellet_static__/reload.js');
  expect(page.body).toMatch(/<\/html><script[^>]*><\/script>$/);
  expect(await fs.readFile(path.join(root, 'index.html'), 'utf8')).not.toContain('reload.js');
  const redirect = await app.inject('/nested?query=1');
  expect(redirect.statusCode).toBe(302);
  expect(redirect.headers.location).toBe('/nested/?query=1');
  expect((await app.inject('/nested/')).body).toContain('Nested page');
  expect((await app.inject('/nested/index.html')).body).toContain('reload.js');
  const head = await app.inject({ method: 'HEAD', url: '/' });
  expect(head.body).toBe('');
  expect(head.headers['content-length']).toBe(page.headers['content-length']);
});
it('preserves inline JavaScript strings containing HTML closing tags', async () => {
  const html =
    '<!doctype html><html><body><script>window.template = "</body>";</script></body></html>';
  await fs.writeFile(path.join(root, 'index.html'), html);
  const page = await app.inject('/');
  expect(page.body).toContain('<script>window.template = "</body>";</script>');
  expect(page.body.startsWith('<!doctype html>')).toBe(true);
});

it.each([
  ['style.css', 'text/css'],
  ['script.js', 'text/javascript'],
  ['module.mjs', 'text/javascript'],
  ['image.svg', 'image/svg+xml'],
  ['font.woff2', 'font/woff2'],
  ['space%20name.txt', 'text/plain'],
  ['linked.css', 'text/css'],
])('serves %s with its correct MIME type and HEAD length', async (file, mime) => {
  const response = await app.inject('/' + file);
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain(mime);
  expect(response.headers['content-length']).toBe(String(Buffer.byteLength(response.body)));
  expect(response.body).not.toContain('reload.js');
  const head = await app.inject({ method: 'HEAD', url: '/' + file });
  expect(head.body).toBe('');
  expect(head.headers['content-length']).toBe(response.headers['content-length']);
});

it.each(['/missing', '/style.css/missing', '/empty/', '/__repellet_static__/unknown'])(
  'returns 404 for %s without an SPA fallback or directory listing',
  async (url) => expect((await app.inject(url)).statusCode).toBe(404),
);
it.each([
  ['/%ZZ', 400],
  ['/%2e%2e/outside.txt', 400],
  ['/nested/%2e%2e/index.html', 400],
  ['/%5coutside.txt', 400],
  ['/%00', 400],
  ['//nested', 400],
  ['/.env', 403],
  ['/%2egit/config', 403],
  ['/hidden.txt', 403],
  ['/escape/outside.txt', 403],
])('rejects unsafe URL %s', async (url, status) => {
  // Injection and fetch normalize dot segments before the server receives them.
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const response = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(address, { path: url }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', reject);
  });
  expect(response).toBe(status);
});
it('allows only GET and HEAD', async () => {
  const response = await app.inject({ method: 'POST', url: '/', payload: 'ignored' });
  expect(response.statusCode).toBe(405);
  expect(response.headers.allow).toBe('GET, HEAD');
});

async function socket(origin?: string) {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new WebSocket(address.replace('http:', 'ws:') + '/__repellet_static__/reload', {
    headers: origin ? { origin: origin === 'self' ? address : origin } : {},
  });
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  return client;
}
it('debounces saved changes and closes reload connections on shutdown', async () => {
  const client = await socket('self');
  const messages: string[] = [];
  client.on('message', (data) => messages.push(String(data)));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>Changed</h1>');
  await fs.writeFile(path.join(root, 'style.css'), 'body { color: blue; }');
  await expect.poll(() => messages, { timeout: 5000 }).toEqual(['reload']);
  const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  const address = app.server.address() as { port: number };
  await app.close();
  await closed;
  const replacement = await createStaticServer(root);
  try {
    await replacement.listen({ host: '127.0.0.1', port: address.port });
  } finally {
    await replacement.close();
  }
});
it('reloads for upload, rename, and deletion but ignores hidden files and dependencies', async () => {
  const client = await socket('self');
  const messages: string[] = [];
  client.on('message', (data) => messages.push(String(data)));
  await fs.writeFile(path.join(root, '.env'), 'changed secret');
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'ignored');
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(messages).toEqual([]);
  await fs.writeFile(path.join(root, 'upload.txt'), 'new asset');
  await expect.poll(() => messages.length, { timeout: 5000 }).toBe(1);
  await fs.rename(path.join(root, 'upload.txt'), path.join(root, 'renamed.txt'));
  await expect.poll(() => messages.length, { timeout: 5000 }).toBe(2);
  await fs.unlink(path.join(root, 'renamed.txt'));
  await expect.poll(() => messages.length, { timeout: 5000 }).toBe(3);
  client.close();
});
it.each([undefined, 'http://attacker.example'])(
  'rejects a reload socket with origin %s',
  async (origin) => {
    const client = await socket(origin);
    expect(await new Promise<number>((resolve) => client.once('close', resolve))).toBe(1008);
  },
);
it('accepts HTTPS preview origins when TLS terminates at the gateway', async () => {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new WebSocket(address.replace('http:', 'ws:') + '/__repellet_static__/reload', {
    headers: { origin: address.replace('http:', 'https:') },
  });
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  const message = new Promise<string>((resolve) =>
    client.once('message', (data) => resolve(String(data))),
  );
  await fs.writeFile(path.join(root, 'style.css'), 'body { color: green; }');
  expect(await message).toBe('reload');
  client.close();
});
