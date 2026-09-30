import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
/** No shell, and no inherited host registry credentials are required by archive helpers. */
export async function runDocker(
  args,
  { input, inputText, output, capture = false, env = process.env } = {},
) {
  const child = spawn(process.env.DOCKER_CLI || 'docker', args, {
    env,
    stdio: [
      input || inputText ? 'pipe' : 'ignore',
      output || capture ? 'pipe' : 'inherit',
      'inherit',
    ],
  });
  let result = '';
  if (capture) child.stdout.on('data', (data) => (result += data.toString()));
  const jobs = [
    new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Docker command failed (' + code + ')')),
      );
    }),
  ];
  if (output)
    jobs.push(pipeline(child.stdout, createWriteStream(output, { mode: 0o600, flags: 'wx' })));
  if (input) jobs.push(pipeline(createReadStream(input), child.stdin));
  if (inputText) {
    child.stdin.on('error', () => {});
    child.stdin.end(inputText);
  }
  try {
    await Promise.all(jobs);
  } catch (error) {
    child.kill();
    throw error;
  }
  return result.trim();
}
