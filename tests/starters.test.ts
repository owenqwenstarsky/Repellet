import { it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { starterCatalog, suggestSetup, projectCreateSchema } from '@repellet/shared';
import { credentialResponse } from '../packages/bridge/src/credentials.js';
let root: string,
  files: typeof import('../packages/bridge/src/files.js'),
  preparation: typeof import('../packages/bridge/src/preparation.js');
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'repellet-starters-'));
  process.env.WORKSPACE_ROOT = root;
  files = await import('../packages/bridge/src/files.js');
  preparation = await import('../packages/bridge/src/preparation.js');
});
afterAll(async () => {
  await preparation?.cancelPreparation();
  await fs.rm(root, { recursive: true, force: true });
});
it('bundles versioned, pinned starters and a compatible React npm lockfile', async () => {
  for (const starter of starterCatalog) {
    const directory = `apps/api/starters/${starter.id}/${starter.version}`;
    expect(await fs.readFile(`${directory}/README.md`, 'utf8')).toBeTruthy();
    expect(await fs.readFile(`${directory}/.gitignore`, 'utf8')).toBeTruthy();
    expect(await fs.readFile(`${directory}/${starter.initialFile}`, 'utf8')).toBeTruthy();
  }
  const manifest = JSON.parse(
      await fs.readFile('apps/api/starters/react-vite/1/package.json', 'utf8'),
    ),
    lock = JSON.parse(
      await fs.readFile('apps/api/starters/react-vite/1/package-lock.json', 'utf8'),
    );
  expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
  expect(lock.packages[''].devDependencies).toEqual(manifest.devDependencies);
  expect(() =>
    projectCreateSchema.parse({
      name: 'bad',
      runtimes: ['node'],
      starterId: 'react-vite',
      cloneUrl: 'https://github.com/a/b.git',
    }),
  ).toThrow();
});
it('resumes scaffolding without overwriting edits and indexes safely', async () => {
  await preparation.scaffold([
    { path: 'src/a.ts', content: 'original' },
    { path: 'README.md', content: 'readme' },
  ]);
  await fs.writeFile(path.join(root, 'src/a.ts'), 'edited');
  await preparation.scaffold([
    { path: 'src/a.ts', content: 'overwrite' },
    { path: 'src/b.ts', content: 'new' },
  ]);
  expect(await fs.readFile(path.join(root, 'src/a.ts'), 'utf8')).toBe('edited');
  for (const dir of ['.git', 'node_modules', '.venv', 'dist', 'target']) {
    await fs.mkdir(path.join(root, dir));
    await fs.writeFile(path.join(root, dir, 'ignored'), 'ignored');
  }
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
  expect((await files.fileIndex()).paths).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
  expect((await files.fileIndex(1)).truncated).toBe(true);
});
it('tracks exit status and bounds managed process output', async () => {
  await preparation.startPreparation('success', "printf 'ready'; exit 0", '');
  await expect.poll(() => preparation.processStatus('success').state).toBe('succeeded');
  expect(preparation.processStatus('success').exitCode).toBe(0);
  await preparation.startPreparation('failure', "printf 'failed'; exit 7", '');
  await expect.poll(() => preparation.processStatus('failure').state).toBe('failed');
  expect(preparation.processStatus('failure').exitCode).toBe(7);
  await preparation.startPreparation('cancel', 'sleep 30', '');
  await preparation.cancelPreparation();
  expect(preparation.processStatus('cancel').state).toBe('cancelled');
});
it('requires an exact credential target and never stores credentials', () => {
  const input = 'protocol=https\nhost=github.com\npath=owner/repo.git\n';
  expect(credentialResponse(input, 'get', 'https://github.com/owner/repo.git', 'secret')).toContain(
    'password=secret',
  );
  for (const bad of [
    input.replace('github.com', 'attacker.com'),
    input.replace('owner/repo', 'other/repo'),
    input.replace('https', 'http'),
  ])
    expect(credentialResponse(bad, 'get', 'https://github.com/owner/repo.git', 'secret')).toBe('');
  for (const action of ['store', 'erase'])
    expect(credentialResponse(input, action, 'https://github.com/owner/repo.git', 'secret')).toBe(
      '',
    );
});
it('suggests commands without executing manifest scripts', () => {
  const files = {
    'package.json': JSON.stringify({
      scripts: { dev: 'vite' },
      devDependencies: { vite: '7.3.6' },
    }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3 }),
  };
  expect(suggestSetup(files, 'web').setupCommand).toBe('npm ci');
  expect(suggestSetup(files, 'web').runConfig.command).toContain('--strictPort');
  expect(suggestSetup({ ...files, 'pnpm-lock.yaml': 'lock' }, '').setupCommand).toBe('');
  expect(
    suggestSetup({ 'requirements.txt': 'fastapi==0.115.12', 'main.py': 'app = FastAPI()' }, '')
      .runConfig.command,
  ).toContain('main:app');
  expect(suggestSetup({ 'go.mod': 'module test' }, '').setupCommand).toBe('go mod download');
  expect(suggestSetup({ 'Cargo.toml': '[package]' }, '').setupCommand).toBe('cargo fetch');
});
