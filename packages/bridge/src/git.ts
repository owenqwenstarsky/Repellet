import { exec, root, relative, resolvePath } from './files.js';
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
  return { diff: stdout };
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
