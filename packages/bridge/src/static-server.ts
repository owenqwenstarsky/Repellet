import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import chokidar from 'chokidar';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentType, lookup } from 'mime-types';
import type { WebSocket } from 'ws';

const prefix = '/__repellet_static__/';
const scriptTag = `<script src="${prefix}reload.js"></script>`;
// Reload after reconnection too: writes can happen while the server is restarting.
const reloadScript = `(() => {
  let connected = false;
  let delay = 500;
  function connect() {
    const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '${prefix}reload');
    socket.onopen = () => {
      if (connected) location.reload();
      connected = true;
      delay = 500;
    };
    socket.onmessage = (event) => { if (event.data === 'reload') location.reload(); };
    socket.onclose = (event) => {
      if (event.code === 1008) return;
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 10000);
    };
  }
  connect();
})();`;

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

function requestPath(url: string) {
  const rawPath = url.split('?')[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw httpError(400, 'Malformed URL path');
  }
  if (
    !decoded.startsWith('/') ||
    decoded.startsWith('//') ||
    /[\\\x00-\x1f\x7f]/.test(decoded) ||
    decoded.split('/').includes('..')
  )
    throw httpError(400, 'Path must stay within the served folder');
  if (decoded.split('/').some((part) => part.startsWith('.')))
    throw httpError(403, 'Hidden files are not served');
  return decoded;
}

/** A separate app process: it never exposes the authenticated bridge's routes. */
export async function createStaticServer(directory: string) {
  const root = await fs.realpath(directory);
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Serve a directory');
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const clients = new Set<WebSocket>();
  let initialized = false;
  const versions = new Map<string, string>();
  const version = (stat: { mtimeMs: number; size: number }) => `${stat.mtimeMs}:${stat.size}`;
  const ignoredPath = (filename: string) =>
    path
      .relative(root, filename)
      .split(path.sep)
      .some((part) => part.startsWith('.') || ['node_modules', 'vendor', 'target'].includes(part));
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    // Preview roots live in containers and mounted workspaces where the native
    // fs watcher can exhaust the host's watch descriptors (EMFILE). Polling is
    // slightly less efficient, but keeps the preview server available and the
    // reload behavior deterministic across those environments.
    usePolling: true,
    followSymlinks: false,
    ignored: (filename, stat) => {
      if (stat?.isSymbolicLink() || ignoredPath(filename)) return true;
      if (!initialized && stat?.isFile()) versions.set(filename, version(stat));
      return false;
    },
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  watcher.on('all', async (event, filename) => {
    // Some watcher backends emit symlink events even with followSymlinks disabled.
    if (filename === root || ignoredPath(filename)) return;
    try {
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) return;
      if (stat.isFile()) {
        const current = version(stat);
        // Filesystem backends can report reads or metadata changes as writes.
        if (versions.get(filename) === current) return;
        versions.set(filename, current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      versions.delete(filename);
    }
    if (closing) return;
    if (!initialized || (event === 'change' && !versions.has(filename))) return;
    clearTimeout(timer);
    // A rename's removal can arrive before the new path's 200 ms write-stability check.
    timer = setTimeout(() => {
      for (const client of clients) if (client.readyState === 1) client.send('reload');
    }, 250);
  });
  watcher.on('error', (error) => console.error('Static preview watcher:', error));
  app.addHook('onClose', async () => {
    closing = true;
    clearTimeout(timer);
    for (const client of clients) client.terminate();
    await watcher.close();
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    requestPath(req.raw.url || '/');
    if (!['GET', 'HEAD'].includes(req.method))
      return reply.header('allow', 'GET, HEAD').code(405).send('Method not allowed');
  });
  app.get(prefix + 'reload.js', async (_req, reply) =>
    reply.type('text/javascript; charset=utf-8').send(reloadScript),
  );
  app.get(prefix + 'reload', { websocket: true }, (client, req) => {
    // The preview gateway validates member access and the external preview origin.
    let origin: URL | undefined;
    try {
      origin = new URL(req.headers.origin || '');
    } catch {}
    // TLS may terminate before the gateway; its upstream connection remains HTTP.
    if (
      !origin ||
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.host !== req.headers.host
    ) {
      client.close(1008, 'Invalid preview origin');
      return;
    }
    clients.add(client);
    client.on('close', () => clients.delete(client));
  });

  async function resolveFile(relative: string) {
    const resolved = await fs.realpath(path.join(root, relative));
    const within = path.relative(root, resolved);
    if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within))
      throw httpError(403, 'Symlink escapes the served folder');
    if (within.split(path.sep).some((part) => part.startsWith('.')))
      throw httpError(403, 'Hidden files are not served');
    return resolved;
  }
  app.get('/*', async (req, reply) => {
    const pathname = requestPath(req.raw.url || '/');
    if (pathname.startsWith(prefix)) return reply.code(404).send('Not found');
    try {
      let filename = await resolveFile(pathname.slice(1));
      let stat = await fs.stat(filename);
      if (stat.isDirectory()) {
        if (!pathname.endsWith('/')) {
          const rawUrl = req.raw.url!;
          const query = rawUrl.indexOf('?');
          return reply.redirect(
            (query === -1 ? rawUrl : rawUrl.slice(0, query)) +
              '/' +
              (query === -1 ? '' : rawUrl.slice(query)),
          );
        }
        filename = await resolveFile(path.posix.join(pathname.slice(1), 'index.html'));
        stat = await fs.stat(filename);
      }
      if (!stat.isFile()) return reply.code(404).send('Not found');
      const mime = lookup(filename) || 'application/octet-stream';
      reply.type(contentType(mime) || mime);
      // Larger files stream unchanged; the editor also limits text files to 2 MiB.
      if (mime === 'text/html' && stat.size <= 2 * 1024 * 1024) {
        const html = await fs.readFile(filename, 'utf8');
        // Appending preserves doctypes and strings containing HTML closing tags.
        const injected = html + scriptTag;
        return reply.header('content-length', Buffer.byteLength(injected)).send(injected);
      }
      reply.header('content-length', stat.size);
      return reply.send(createReadStream(filename));
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || ''))
        return reply.code(404).send('Not found');
      throw error;
    }
  });
  await new Promise<void>((resolve, reject) => {
    watcher.once('ready', () => {
      initialized = true;
      resolve();
    });
    watcher.once('error', reject);
  }).catch(async (error) => {
    await app.close();
    throw error;
  });
  return app;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]!))
    throw new Error('Usage: static-server.js --port PORT');
  const port = Number(args[1]);
  if (port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
  const app = await createStaticServer(process.cwd());
  const stop = () => {
    void app.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await app.listen({ host: '0.0.0.0', port });
    console.log(`Serving ${process.cwd()} on 0.0.0.0:${port} (automatic preview refresh enabled)`);
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch((error) => {
    console.error('Static server:', error.message);
    process.exitCode = 1;
  });
