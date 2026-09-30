import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let temp: string;
let files: typeof import('../packages/bridge/src/files.js');
beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'repellet-files-'));
  process.env.WORKSPACE_ROOT = path.join(temp, 'workspace');
  await fs.mkdir(process.env.WORKSPACE_ROOT);
  files = await import('../packages/bridge/src/files.js');
});
afterAll(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});
describe('filesystem writes and isolation', () => {
  it('keeps edits atomic and rejects stale contents', async () => {
    const first = await files.writeFile('src/main.ts', 'first', null);
    await files.writeFile('src/main.ts', 'second', first.hash);
    await expect(files.writeFile('src/main.ts', 'stale', first.hash)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await files.readFile('src/main.ts')).content).toBe('second');
    expect(
      (await fs.readdir(path.join(files.root, 'src'))).some((n) => n.startsWith('.repellet-tmp')),
    ).toBe(false);
  });
  it('accepts exactly one of two concurrent writes from the same revision', async () => {
    const initial = await files.writeFile('race.txt', 'initial', null);
    const results = await Promise.allSettled([
      files.writeFile('race.txt', 'one', initial.hash),
      files.writeFile('race.txt', 'two', initial.hash),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(['one', 'two']).toContain((await files.readFile('race.txt')).content);
  });
  it('rejects symlink escapes for reading and writing', async () => {
    await fs.writeFile(path.join(temp, 'secret'), 'private');
    await fs.symlink(temp, path.join(files.root, 'outside'));
    await expect(files.readFile('outside/secret')).rejects.toMatchObject({ statusCode: 403 });
    await expect(files.writeFile('outside/new', 'bad', null)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await fs.readFile(path.join(temp, 'secret'), 'utf8')).toBe('private');
  });
  it('marks binary and oversized files as download-only', async () => {
    await fs.writeFile(path.join(files.root, 'image.bin'), Buffer.from([1, 0, 2]));
    expect((await files.readFile('image.bin')).binary).toBe(true);
    await fs.writeFile(path.join(files.root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    expect((await files.readFile('large.txt')).binary).toBe(true);
  });
  it('supports safe symlinks inside the project', async () => {
    await fs.symlink('src/main.ts', path.join(files.root, 'main.ts'));
    expect((await files.readFile('main.ts')).content).toBe('second');
  });
});
