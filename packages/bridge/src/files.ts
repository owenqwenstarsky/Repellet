import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
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
      mode: current ? (await fs.stat(p)).mode | 0o660 : 0o664,
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

export async function fileIndex(limit = 20000) {
  const paths: string[] = [];
  let truncated = false;
  const excluded = new Set([
    '.git',
    'node_modules',
    '.venv',
    'venv',
    'target',
    'vendor',
    'dist',
    'build',
    '.next',
    '__pycache__',
    '.cache',
    'coverage',
  ]);
  async function visit(dir: string) {
    const entries = await fs.readdir(await resolvePath(dir), { withFileTypes: true });
    for (const entry of entries) {
      if (
        excluded.has(entry.name) ||
        entry.name.startsWith('.repellet-tmp-') ||
        entry.isSymbolicLink()
      )
        continue;
      if (paths.length >= limit) {
        truncated = true;
        return;
      }
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) await visit(rel);
      else if (entry.isFile()) paths.push(rel);
      if (truncated) return;
    }
  }
  await visit('');
  return { paths: paths.sort(), truncated };
}

// Enumerate file names separately from the bounded search-results display.
export async function matchingFiles(query: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'rg',
      [
        '--files-with-matches',
        '--null',
        '--fixed-strings',
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
      { cwd: root },
    );
    const names: string[] = [];
    let remainder = Buffer.alloc(0),
      stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      remainder = Buffer.concat([remainder, chunk]);
      let end: number;
      while ((end = remainder.indexOf(0)) !== -1) {
        names.push(remainder.subarray(0, end).toString('utf8').replace(/^\.\//, ''));
        remainder = remainder.subarray(end + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 || code === 1 ? resolve(names) : reject(new Error(stderr || 'File search failed')),
    );
  });
}
export async function replaceFiles(
  query: string,
  replacement: string,
  checkWrite: (delta: number) => Promise<void>,
) {
  const completedFiles: string[] = [];
  const skippedFiles: string[] = [];
  try {
    for (const name of await matchingFiles(query)) {
      const file = await readFile(name);
      if (file.binary) {
        skippedFiles.push(name);
        continue;
      }
      if (!file.content.includes(query)) continue;
      const content = file.content.split(query).join(replacement);
      await checkWrite(Buffer.byteLength(content) - file.size);
      await writeFile(name, content, file.hash);
      completedFiles.push(name);
    }
  } catch (error) {
    const cause = error as Error & { statusCode?: number };
    throw Object.assign(
      new Error(
        `Replacement stopped after updating ${completedFiles.length} file(s): ${cause.message}`,
      ),
      { statusCode: cause.statusCode || 500, completedFiles },
    );
  }
  return { files: completedFiles.length, skippedFiles };
}
