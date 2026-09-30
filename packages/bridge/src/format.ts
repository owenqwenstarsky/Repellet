import path from 'node:path';
import { spawn } from 'node:child_process';
import { relative, root } from './files.js';
import { getEnvironment } from './terminals.js';
/** Format the supplied editor revision; never read or mutate the disk file. */
export async function formatFile(input: string, content: string) {
  const filename = relative(input);
  if (!filename || typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024)
    throw Object.assign(new Error('A text file smaller than 2 MiB is required'), {
      statusCode: 400,
    });
  const extension = path.extname(filename);
  let command: string;
  let args: string[];
  if (extension === '.py') {
    command = 'ruff';
    args = ['format', '--stdin-filename', filename, '-'];
  } else if (
    ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.css', '.html', '.md'].includes(
      extension,
    )
  ) {
    command = '/opt/repellet/node/bin/node';
    args = [
      '/opt/language-tools/node_modules/prettier/bin/prettier.cjs',
      '--stdin-filepath',
      filename,
    ];
  } else if (extension === '.go') {
    command = 'gofmt';
    args = [];
  } else if (extension === '.rs') {
    command = 'rustfmt';
    args = ['--emit', 'stdout', '--edition', '2024'];
  } else
    throw Object.assign(new Error('Formatting is not available for this file type'), {
      statusCode: 400,
    });
  return new Promise<{ content: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: getEnvironment(), stdio: 'pipe' });
    let output = '',
      errors = '',
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(Object.assign(error, { statusCode: 422 })) : resolve({ content: output });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Formatter timed out'));
    }, 15000);
    child.on('error', (e) =>
      finish(new Error('Formatter is unavailable. Select the matching runtime. ' + e.message)),
    );
    child.stdout.on('data', (data) => {
      output += data.toString();
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) {
        child.kill('SIGKILL');
        finish(new Error('Formatted file is too large'));
      }
    });
    child.stderr.on('data', (data) => (errors = (errors + data.toString()).slice(-4096)));
    child.stdin.on('error', () => {});
    child.on('exit', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(errors.trim() || 'Formatting failed. Check the file for syntax errors.'),
      ),
    );
    child.stdin.end(content);
  });
}
