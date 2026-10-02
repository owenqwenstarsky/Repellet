import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import chokidar from 'chokidar';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import tar from 'tar-stream';
import type { WebSocket } from 'ws';
import {
  root,
  relative,
  resolvePath,
  listFiles,
  fileIndex,
  readFile,
  writeFile,
  search,
  replaceFiles,
  usage,
  exec,
} from './files.js';
import {
  createTerminal,
  stopTerminal,
  stopAll,
  attachTerminal,
  info,
  setEnvironment,
} from './terminals.js';
import { attachLanguage, stopLanguages } from './language.js';
import { formatFile } from './format.js';
import {
  startPreparation,
  processStatus,
  cancelPreparation,
  scaffold,
  dependencyFingerprint,
} from './preparation.js';
import { git, gitDiff, unstageFiles } from './git.js';
const token = process.env.BRIDGE_TOKEN || '';
if (token.length < 32) throw new Error('BRIDGE_TOKEN must be at least 32 characters');
const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024 });
await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });
app.addHook('onRequest', async (req, reply) => {
  const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return reply.code(401).send({ error: 'Unauthorized' });
});
app.setErrorHandler((error, req, reply) => {
  const e = error as Error & { statusCode?: number; code?: string; completedFiles?: string[] };
  reply
    .code(e.statusCode || (e.code === 'ENOENT' ? 404 : 500))
    .send({ error: e.message, ...(e.completedFiles ? { completedFiles: e.completedFiles } : {}) });
});
let storageLimit = Number(process.env.STORAGE_LIMIT_MB || 5120) * 1024 * 1024;
let measured = 0;
let suspended = false;
async function checkWrite(delta = 0) {
  if (measured + delta > storageLimit)
    throw Object.assign(new Error('Project storage limit reached. Delete files to resume.'), {
      statusCode: 507,
    });
}
app.post('/preparation', async (req) => {
  if (suspended)
    throw Object.assign(new Error('Execution suspended: storage limit exceeded'), {
      statusCode: 507,
    });
  const b = req.body as { id: string; command: string; cwd: string };
  return startPreparation(b.id, b.command, b.cwd);
});
app.get('/preparation/:id', async (req) => processStatus((req.params as { id: string }).id));
app.post('/preparation/cancel', async () => cancelPreparation());
app.post('/scaffold', async (req) => {
  await checkWrite();
  return scaffold((req.body as { files: { path: string; content: string }[] }).files);
});
app.post('/fingerprint', async (req) => {
  const b = req.body as { cwd: string; command: string };
  return dependencyFingerprint(b.cwd, b.command);
});
app.get('/health', async () => ({ ok: true }));
app.get('/files', async (req) =>
  listFiles(String((req.query as Record<string, string>).path || '')),
);
app.get('/file-index', async () => fileIndex());
app.get('/file', async (req) => readFile(String((req.query as Record<string, string>).path || '')));
app.put('/file', async (req) => {
  const b = req.body as { path: string; content: string; expectedHash?: string | null };
  if (typeof b.content !== 'string')
    throw Object.assign(new Error('Content must be text'), { statusCode: 400 });
  const old = await readFile(b.path).catch((e) => {
    if (e.code === 'ENOENT') return { size: 0 };
    throw e;
  });
  await checkWrite(Buffer.byteLength(b.content) - old.size);
  return writeFile(b.path, b.content, b.expectedHash);
});
app.post('/files/create', async (req) => {
  const b = req.body as { path: string; kind: string };
  await checkWrite();
  const p = await resolvePath(b.path, true);
  if (!relative(b.path)) throw Object.assign(new Error('A path is required'), { statusCode: 400 });
  if (b.kind === 'directory') await fs.mkdir(p, { recursive: false });
  else await fs.writeFile(p, '', { flag: 'wx' });
  return { ok: true };
});
app.post('/files/move', async (req) => {
  const b = req.body as { from: string; to: string };
  if (!relative(b.from) || !relative(b.to))
    throw Object.assign(new Error('Root cannot be moved'), { statusCode: 400 });
  const from = await resolvePath(b.from),
    to = await resolvePath(b.to, true);
  try {
    await fs.lstat(to);
    throw Object.assign(new Error('Destination already exists'), { statusCode: 409 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
  return { ok: true };
});
app.post('/files/delete', async (req) => {
  const b = req.body as { path: string };
  if (!relative(b.path))
    throw Object.assign(new Error('Root cannot be deleted'), { statusCode: 400 });
  await fs.rm(await resolvePath(b.path), { recursive: true, force: false });
  measured = await usage();
  return { ok: true };
});
app.post('/files/upload', async (req) => {
  const b = req.body as { path: string; data: string };
  const data = Buffer.from(b.data, 'base64');
  await checkWrite(data.length);
  const p = await resolvePath(b.path, true);
  if (!relative(b.path)) throw Object.assign(new Error('A path is required'), { statusCode: 400 });
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data, { flag: 'wx' });
  return { ok: true };
});
app.get('/files/download', async (req, reply) => {
  const rel = relative(String((req.query as Record<string, string>).path));
  const p = await resolvePath(rel);
  const stat = await fs.stat(p);
  if (stat.isDirectory())
    return reply
      .header('content-type', 'application/x-tar')
      .header('x-repellet-archive', 'true')
      .send(archive(rel));
  return reply.header('content-type', 'application/octet-stream').send(createReadStream(p));
});
app.get('/search', async (req) =>
  search(String((req.query as Record<string, string>).query || '')),
);
app.post('/format', async (req) => {
  const b = req.body as { path: string; content: string };
  return formatFile(b.path, b.content);
});
app.post('/replace', async (req) => {
  const b = req.body as { query: string; replacement: string };
  if (!b.query || typeof b.replacement !== 'string')
    throw Object.assign(new Error('Search and replacement are required'), { statusCode: 400 });
  return replaceFiles(b.query, b.replacement, checkWrite);
});
app.get('/terminals', async () => info());
app.post('/terminals', async (req) => {
  if (suspended)
    throw Object.assign(new Error('Execution suspended: storage limit exceeded'), {
      statusCode: 507,
    });
  const b = req.body as { name?: string };
  const session = await createTerminal((b.name || 'Terminal').slice(0, 80));
  return info().find((t) => t.id === session.id);
});
app.delete('/terminals/:id', async (req) => {
  await stopTerminal((req.params as { id: string }).id);
  return { ok: true };
});
app.get('/terminals/:id/connect', { websocket: true }, (ws, req) =>
  attachTerminal(ws, (req.params as { id: string }).id),
);
app.post('/run', async (req) => {
  if (suspended)
    throw Object.assign(new Error('Execution suspended: storage limit exceeded'), {
      statusCode: 507,
    });
  const b = req.body as { command: string; cwd: string };
  if (!b.command?.trim())
    throw Object.assign(new Error('Set a run command first'), { statusCode: 400 });
  await stopTerminal('run');
  await createTerminal('Run', b.command, b.cwd);
  return { ok: true };
});
app.post('/run/stop', async () => {
  await stopTerminal('run');
  return { ok: true };
});
app.put('/environment', async (req) => {
  setEnvironment(req.body as Record<string, string>);
  return { ok: true };
});
app.put('/limits', async (req) => {
  storageLimit = (req.body as { storageMb: number }).storageMb * 1024 * 1024;
  return { ok: true };
});
app.get('/language/:runtime', { websocket: true }, (ws, req) => {
  if (suspended) {
    ws.close(1008, 'Storage limit exceeded');
    return;
  }
  attachLanguage(ws, (req.params as { runtime: string }).runtime);
});
const events = new Set<WebSocket>();
app.get('/events', { websocket: true }, (ws) => {
  events.add(ws);
  ws.on('close', () => events.delete(ws));
});
const emit = (event: unknown) => {
  for (const ws of events) if (ws.readyState === 1) ws.send(JSON.stringify(event));
};
const watcher = chokidar.watch(root, {
  ignoreInitial: true,
  followSymlinks: false,
  ignored: (p) =>
    p
      .split('/')
      .some(
        (v) =>
          ['.git', 'node_modules', '.venv', 'target', 'vendor'].includes(v) ||
          v.startsWith('.repellet-tmp-'),
      ),
  awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
});
watcher.on('error', (error) => {
  app.log.warn({ err: error }, 'Filesystem watcher error');
  emit({
    type: 'error',
    message: 'Some files could not be watched. Refresh the file tree to retry.',
  });
});
watcher.on('all', (event, p) => emit({ type: 'file', event, path: path.relative(root, p) }));
app.get('/usage', async () => {
  measured = await usage();
  const exceeded = measured > storageLimit;
  if (exceeded && !suspended) {
    suspended = true;
    await cancelPreparation();
    await stopAll();
    stopLanguages();
    emit({ type: 'storage', exceeded: true, bytes: measured });
  } else if (!exceeded && suspended) {
    suspended = false;
    emit({ type: 'storage', exceeded: false, bytes: measured });
  }
  return { bytes: measured, exceeded };
});
app.get('/git/remote', async () => {
  const fetch = (await git(['remote', 'get-url', '--all', 'origin'])).stdout.trim().split('\n');
  const push = (await git(['remote', 'get-url', '--push', '--all', 'origin'])).stdout
    .trim()
    .split('\n');
  if (fetch.length !== 1 || push.length !== 1 || fetch[0] !== push[0])
    throw new Error('Use one matching origin URL for fetch and push');
  return { url: fetch[0] };
});
app.post('/inspect', async (req) => {
  const cwd = relative((req.body as { cwd: string }).cwd);
  const files: Record<string, string> = {};
  for (const name of [
    'index.html',
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
    'main.py',
    'app.py',
    'main.go',
  ]) {
    try {
      const file = await readFile(path.posix.join(cwd, name));
      if (!file.binary && file.hash) files[name] = file.content;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return { files };
});
app.get('/git/status', async () => {
  try {
    const { stdout } = await git(['status', '--porcelain=v1', '-z']);
    const pieces = stdout.split('\0');
    const entries = [];
    for (let i = 0; i < pieces.length; i++) {
      const item = pieces[i];
      if (!item) continue;
      entries.push({ path: item.slice(3), index: item[0], worktree: item[1] });
      if (item[0] === 'R' || item[0] === 'C') i++;
    }
    const { stdout: branch } = await git(['branch', '--show-current']);
    const branches = (
      await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
    ).stdout
      .trim()
      .split('\n')
      .filter((name) => !!name && !name.endsWith('/HEAD'));
    const upstream = await git(['rev-parse', '--abbrev-ref', '@{upstream}'])
      .then((r) => r.stdout.trim())
      .catch(() => null);
    const counts = upstream
      ? (await git(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout
          .trim()
          .split(/\s+/)
          .map(Number)
      : [0, 0];
    return {
      initialized: true,
      branch: branch.trim() || '(detached)',
      entries,
      branches,
      upstream,
      ahead: counts[0],
      behind: counts[1],
    };
  } catch (e) {
    if (String((e as Error).message).includes('not a git repository'))
      return {
        initialized: false,
        branch: '',
        entries: [],
        branches: [],
        upstream: null,
        ahead: 0,
        behind: 0,
      };
    throw e;
  }
});
app.get('/git/diff', async (req) => {
  const b = req.query as { path?: string; staged?: string };
  return gitDiff(b.path, b.staged === 'true');
});
app.post('/git', async (req) => {
  if (suspended) throw Object.assign(new Error('Storage limit exceeded'), { statusCode: 507 });
  const b = req.body as {
    action: string;
    paths?: string[];
    message?: string;
    branch?: string;
    name?: string;
    email?: string;
    url?: string;
    credential?: { token: string; remote: string };
  };
  for (const p of b.paths || []) relative(p);
  let args: string[];
  switch (b.action) {
    case 'init':
      args = ['init'];
      break;
    case 'stage':
      if (!b.paths?.length) throw new Error('Select files');
      args = ['add', '--', ...b.paths];
      break;
    case 'unstage':
      if (!b.paths?.length) throw new Error('Select files');
      return { output: (await unstageFiles(b.paths)).stdout };
    case 'commit':
      if (!b.message?.trim()) throw new Error('Commit message is required');
      await git(['config', 'user.name', b.name || 'Repellet']);
      await git(['config', 'user.email', b.email || 'workspace@repellet.local']);
      args = ['commit', '-m', b.message];
      break;
    case 'pull':
      args = ['pull', '--ff-only'];
      break;
    case 'push':
      const upstream = await git(['rev-parse', '--abbrev-ref', '@{upstream}'])
        .then(() => true)
        .catch(() => false);
      const branch = (await git(['branch', '--show-current'])).stdout.trim();
      if (!branch) throw new Error('Switch to a branch before pushing');
      args = upstream ? ['push'] : ['push', '--set-upstream', 'origin', branch];
      break;
    case 'branch':
    case 'checkout':
      if (!b.branch || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(b.branch) || b.branch.includes('..'))
        throw new Error('Invalid branch name');
      args = b.action === 'branch' ? ['switch', '-c', b.branch] : ['switch', b.branch];
      if (b.action === 'checkout') {
        const remote = await git(['show-ref', '--verify', `refs/remotes/${b.branch}`])
          .then(() => true)
          .catch(() => false);
        if (remote) {
          const local = b.branch.slice(b.branch.indexOf('/') + 1);
          const exists = await git(['show-ref', '--verify', `refs/heads/${local}`])
            .then(() => true)
            .catch(() => false);
          args = exists ? ['switch', local] : ['switch', '--track', '-c', local, b.branch];
        }
      }
      break;
    case 'clone':
      if (
        !b.url ||
        !(/^https:\/\/[^\s]+$/.test(b.url) || /^git@[a-zA-Z0-9.-]+:[^\s]+$/.test(b.url))
      )
        throw new Error('Use HTTPS or git@ SSH URL');
      args = ['clone', '--', b.url, '.'];
      break;
    default:
      throw Object.assign(new Error('Unknown Git action'), { statusCode: 400 });
  }
  let result;
  if (b.credential && ['clone', 'pull', 'push'].includes(b.action)) {
    const remote = b.credential.remote;
    const url = new URL(remote);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname)
    )
      throw new Error('Invalid credential target');
    if (b.action === 'clone') {
      if (b.url !== remote) throw new Error('Clone target changed');
      const status = await git(['rev-parse', '--is-inside-work-tree'])
        .then(() => true)
        .catch(() => false);
      if (status) {
        const existing = (await git(['remote', 'get-url', 'origin'])).stdout.trim();
        if (existing === remote) return { output: 'Repository already cloned' };
        throw new Error('Workspace already has a different repository');
      }
    } else {
      for (const push of [false, true]) {
        const actual = (
          await git(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', 'origin'])
        ).stdout.trim();
        if (actual !== remote)
          throw new Error(
            'Origin remote changed. Reconnect the matching repository in settings before using credentials.',
          );
      }
      if (b.action === 'pull') args = ['pull', '--ff-only', 'origin'];
      else {
        const branch = (await git(['branch', '--show-current'])).stdout.trim();
        if (!branch) throw new Error('Switch to a branch before pushing');
        args = ['push', '--set-upstream', 'origin', branch];
      }
    }
    const quote = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";
    const helper =
      '!' +
      quote(process.execPath) +
      ' ' +
      quote(fileURLToPath(new URL('./credentials.js', import.meta.url)));
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      REPELLET_GIT_TOKEN: b.credential.token,
      REPELLET_GIT_REMOTE: remote,
    };
    for (const key of Object.keys(env))
      if (/^GIT_TRACE|^GIT_CURL_VERBOSE|^GIT_CONFIG/.test(key))
        delete (env as Record<string, string | undefined>)[key];
    const redact = (value: string) =>
      value
        .replaceAll(b.credential!.token, '[redacted]')
        .replaceAll(encodeURIComponent(b.credential!.token), '[redacted]');
    try {
      result = await exec(
        'git',
        [
          '-c',
          'credential.helper=',
          '-c',
          `credential.helper=${helper}`,
          '-c',
          'credential.useHttpPath=true',
          '-c',
          'http.followRedirects=false',
          '-c',
          'http.extraHeader=',
          '-c',
          `credential.${remote}.helper=`,
          '-c',
          `credential.${remote}.helper=${helper}`,
          '-c',
          `http.${remote}.followRedirects=false`,
          '-c',
          `http.${remote}.extraHeader=`,
          '-c',
          `http.${remote}.sslVerify=true`,
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: root, env, maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
      );
    } catch (e) {
      throw new Error(redact((e as Error).message));
    }
    return { output: redact(result.stdout + result.stderr) };
  }
  result = await git(args);
  return { output: result.stdout + result.stderr };
});
function archive(directory = '') {
  const pack = tar.pack();
  void (async () => {
    try {
      async function add(dir: string) {
        for (const entry of await fs.readdir(await resolvePath(dir), { withFileTypes: true })) {
          if (
            entry.name.startsWith('.repellet-tmp-') ||
            ['node_modules', '.venv', 'target'].includes(entry.name)
          )
            continue;
          const rel = path.posix.join(dir, entry.name);
          const name = path.posix.relative(directory, rel);
          if (entry.isSymbolicLink()) continue;
          const p = await resolvePath(rel);
          if (entry.isDirectory()) {
            await new Promise<void>((resolve, reject) =>
              pack.entry({ name: name + '/', type: 'directory', mode: 0o755 }, (e) =>
                e ? reject(e) : resolve(),
              ),
            );
            await add(rel);
          } else if (entry.isFile()) {
            const stat = await fs.stat(p);
            await new Promise<void>((resolve, reject) => {
              const entryStream = pack.entry(
                { name, size: stat.size, mode: stat.mode & 0o777 },
                (e) => (e ? reject(e) : resolve()),
              );
              createReadStream(p).on('error', reject).pipe(entryStream);
            });
          }
        }
      }
      await add(directory);
      pack.finalize();
    } catch (e) {
      pack.destroy(e as Error);
    }
  })();
  return pack;
}
app.get('/export', async (_req, reply) =>
  reply.header('content-type', 'application/x-tar').send(archive()),
);
app.post('/shutdown', async () => {
  await cancelPreparation();
  await stopAll();
  stopLanguages();
  return { ok: true };
});
await fs.mkdir(root, { recursive: true });
await app.listen({ host: '0.0.0.0', port: Number(process.env.BRIDGE_PORT || 8787) });
async function shutdown() {
  await watcher.close();
  await cancelPreparation();
  await stopAll();
  stopLanguages();
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
