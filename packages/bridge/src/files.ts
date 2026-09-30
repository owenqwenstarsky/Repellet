import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const exec = promisify(execFile);
export const root = process.env.WORKSPACE_ROOT || '/workspace';
export function relative(input: string): string {
  if (
    typeof input !== 'string' ||
    input.includes('\0') ||
    input.includes('\\') ||
    input.startsWith('/') ||
    /^[A-Za-z]:/.test(input) ||
    input.split('/').includes('..')
  )
    throw Object.assign(new Error('Path must stay within the workspace'), { statusCode: 400 });
  return input
    .split('/')
    .filter((p) => p && p !== '.')
    .join('/');
}
export async function resolvePath(input: string, allowMissing = false): Promise<string> {
  const rel = relative(input),
    absolute = path.join(root, rel);
  let candidate = absolute;
  for (;;) {
    try {
      const resolved = await fs.realpath(candidate);
      const realRoot = await fs.realpath(root);
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep))
        throw Object.assign(new Error('Symlink escapes the workspace'), { statusCode: 403 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) throw e;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw e;
      candidate = parent;
    }
  }
  return absolute;
}
export const hash = (content: Buffer | string) =>
  createHash('sha256').update(content).digest('hex');
export async function readFile(input: string) {
  const p = await resolvePath(input);
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { statusCode: 400 });
    if (stat.size > 2 * 1024 * 1024)
      return { path: relative(input), content: '', hash: null, binary: true, size: stat.size };
    const data = await fs.readFile(p);
    const binary = data.includes(0);
    return {
      path: relative(input),
      content: binary ? '' : data.toString('utf8'),
      hash: hash(data),
      binary,
      size: stat.size,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { path: relative(input), content: '', hash: null, size: 0 };
    throw e;
  }
}
// Serialize IDE mutations so two compare-and-swap writes cannot both accept the same hash.
let mutationQueue: Promise<unknown> = Promise.resolve();
export function fileMutation<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.catch(() => {}).then(operation);
  mutationQueue = next;
  return next;
}
export function writeFile(input: string, content: string, expectedHash: string | null | undefined) {
  return fileMutation(() => writeFileUnlocked(input, content, expectedHash));
}
async function writeFileUnlocked(
  input: string,
  content: string,
  expectedHash: string | null | undefined,
) {
  const rel = relative(input);
  if (!rel) throw Object.assign(new Error('A file path is required'), { statusCode: 400 });
  if (Buffer.byteLength(content) > 2 * 1024 * 1024)
    throw Object.assign(new Error('Editor files are limited to 2 MiB'), { statusCode: 413 });
  const p = await resolvePath(rel, true);
  let current: Buffer | null = null;
  try {
    current = await fs.readFile(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (expectedHash !== undefined && (current ? hash(current) : null) !== expectedHash)
    throw Object.assign(new Error('File changed on disk'), { statusCode: 409 });
  await fs.mkdir(path.dirname(p), { recursive: true });
  await resolvePath(rel, true);
  const temp = path.join(path.dirname(p), `.repellet-tmp-${randomUUID()}`);
  try {
    await fs.writeFile(temp, content, {
      flag: 'wx',
      mode: current ? (await fs.stat(p)).mode : 0o644,
    });
    await fs.rename(temp, p);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return { path: rel, hash: hash(content), size: Buffer.byteLength(content) };
}
export async function listFiles(input: string) {
  const rel = relative(input),
    p = await resolvePath(rel);
  const entries = await fs.readdir(p, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.name !== '.git' && !e.name.startsWith('.repellet-tmp-'))
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      )
      .map(async (e) => {
        const stat = await fs.lstat(path.join(p, e.name));
        return {
          name: e.name,
          path: [rel, e.name].filter(Boolean).join('/'),
          kind: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file',
          size: stat.size,
        };
      }),
  );
}
export async function search(query: string, limit = 300) {
  if (!query) return [];
  const { stdout } = await exec(
    'rg',
    [
      '--json',
      '--fixed-strings',
      '--max-count',
      '10',
      '--glob',
      '!.git/**',
      '--glob',
      '!node_modules/**',
      '--glob',
      '!target/**',
      '--glob',
      '!.venv/**',
      '--glob',
      '!vendor/**',
      '--',
      query,
      '.',
    ],
    { cwd: root, maxBuffer: 8 * 1024 * 1024 },
  ).catch((e) => {
    if (e.code === 1) return { stdout: '' };
    throw e;
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const item = JSON.parse(line);
      return item.type === 'match'
        ? [
            {
              path: item.data.path.text.replace(/^\.\//, ''),
              line: item.data.line_number,
              text: item.data.lines.text.trimEnd(),
            },
          ]
        : [];
    })
    .slice(0, limit);
}
export async function usage() {
  const { stdout } = await exec('du', ['-sb', root, process.env.HOME || '/home/workspace'], {
    maxBuffer: 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + Number(line.split('\t')[0]), 0);
}
