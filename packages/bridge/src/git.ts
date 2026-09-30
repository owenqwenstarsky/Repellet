import { exec, root, relative, resolvePath, readFile } from './files.js';
export const git = (args: string[]) =>
  exec('git', args, {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
export async function gitDiff(file?: string, staged = false) {
  if (file) await resolvePath(file, true);
  const { stdout } = await git([
    'diff',
    ...(staged ? ['--cached'] : []),
    '--',
    ...(file ? [relative(file)] : []),
  ]);
  const rel = relative(file || '');
  const get = async (ref: string) => {
    try {
      return (await git(['show', `${ref}:${rel}`])).stdout;
    } catch (e) {
      if (
        /does not exist|exists on disk|invalid object name|bad revision/.test((e as Error).message)
      )
        return '';
      throw e;
    }
  };
  const original = rel ? await get(staged ? 'HEAD' : '') : '';
  const modified = rel
    ? staged
      ? await get('')
      : (await readFile(rel).catch(() => ({ content: '' }))).content
    : '';
  return { diff: stdout, original, modified };
}
export async function unstageFiles(paths: string[]) {
  paths.forEach(relative);
  let hasHead = true;
  try {
    await git(['rev-parse', '--verify', 'HEAD']);
  } catch {
    hasHead = false;
  }
  return git(
    hasHead ? ['reset', 'HEAD', '--', ...paths] : ['rm', '--cached', '-f', '--', ...paths],
  );
}
