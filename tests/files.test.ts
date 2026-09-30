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

describe('replacement coverage and partial progress', () => {
  it('replaces every matching file beyond 1,000 display rows', async () => {
    await fs.mkdir(path.join(files.root, 'many'));
    const names = Array.from({ length: 110 }, (_, i) => `many/${i}.txt`);
    await Promise.all(
      names.map((name) =>
        fs.writeFile(path.join(files.root, name), 'needle-for-replacement\n'.repeat(12)),
      ),
    );
    const result = await files.replaceFiles('needle-for-replacement', 'updated', async () => {});
    expect(result.files).toBe(110);
    for (const name of names)
      expect((await files.readFile(name)).content).toBe('updated\n'.repeat(12));
  });
  it('reports completed paths if a later write fails', async () => {
    await fs.mkdir(path.join(files.root, 'partial'));
    for (const name of ['one.txt', 'two.txt', 'three.txt'])
      await fs.writeFile(path.join(files.root, 'partial', name), 'partial-needle');
    let checks = 0;
    const error = await files
      .replaceFiles('partial-needle', 'done', async () => {
        if (++checks === 2)
          throw Object.assign(new Error('Storage exhausted'), { statusCode: 507 });
      })
      .catch((e) => e);
    expect(error.statusCode).toBe(507);
    expect(error.completedFiles).toHaveLength(1);
    expect(error.message).toContain('after updating 1 file');
    expect((await files.readFile(error.completedFiles[0])).content).toBe('done');
    const contents = await Promise.all(
      ['one.txt', 'two.txt', 'three.txt'].map((name) => files.readFile('partial/' + name)),
    );
    expect(contents.filter((file) => file.content === 'partial-needle')).toHaveLength(2);
  });
  it('reports oversized files that cannot be edited', async () => {
    await fs.writeFile(
      path.join(files.root, 'oversized.txt'),
      'oversized-needle' + 'x'.repeat(2 * 1024 * 1024),
    );
    const result = await files.replaceFiles('oversized-needle', 'done', async () => {});
    expect(result.files).toBe(0);
    expect(result.skippedFiles).toEqual(['oversized.txt']);
  });
});
describe('Git index and missing-path operations', () => {
  it('unstages before the first commit without removing working files, and diffs deleted files', async () => {
    const { git, unstageFiles, gitDiff } = await import('../packages/bridge/src/git.js');
    await git(['init']);
    await fs.writeFile(path.join(files.root, 'tracked.txt'), 'original\n');
    await git(['add', '--', 'tracked.txt']);
    await unstageFiles(['tracked.txt']);
    expect(await fs.readFile(path.join(files.root, 'tracked.txt'), 'utf8')).toBe('original\n');
    expect((await git(['ls-files', '--', 'tracked.txt'])).stdout).toBe('');
    await git(['add', '--', 'tracked.txt']);
    await git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'Initial',
    ]);
    await fs.rm(path.join(files.root, 'tracked.txt'));
    const unstagedDeletion = await gitDiff('tracked.txt');
    expect(unstagedDeletion.diff).toContain('-original');
    expect(unstagedDeletion).toMatchObject({ original: 'original\n', modified: '' });
    await git(['add', '--', 'tracked.txt']);
    const stagedDeletion = await gitDiff('tracked.txt', true);
    expect(stagedDeletion.diff).toContain('-original');
    expect(stagedDeletion).toMatchObject({ original: 'original\n', modified: '' });
    await unstageFiles(['tracked.txt']);
    expect((await gitDiff('tracked.txt', true)).diff).toBe('');
    await expect(gitDiff('../outside')).rejects.toMatchObject({ statusCode: 400 });
    await expect(gitDiff('outside/missing')).rejects.toMatchObject({ statusCode: 403 });
  });
});
