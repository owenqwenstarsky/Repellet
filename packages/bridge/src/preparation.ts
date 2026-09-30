import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolvePath } from './files.js';
import { getEnvironment } from './terminals.js';
type ProcessJob = {
  id: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  log: string;
  exitCode: number | null;
  child: ChildProcess;
  done: Promise<void>;
};
const jobs = new Map<string, ProcessJob>();
const snapshot = (job: ProcessJob) => ({
  id: job.id,
  state: job.state,
  log: job.log,
  exitCode: job.exitCode,
});
export function processStatus(id: string) {
  const job = jobs.get(id);
  if (!job)
    throw Object.assign(new Error('Preparation process interrupted; retry preparation'), {
      statusCode: 404,
    });
  return snapshot(job);
}
export async function startPreparation(id: string, command: string, cwd: string) {
  if (!/^[a-z0-9-]+$/.test(id) || !command?.trim() || command.length > 4096)
    throw new Error('Invalid preparation');
  if (jobs.has(id)) return processStatus(id);
  if ([...jobs.values()].some((j) => j.state === 'running'))
    throw Object.assign(new Error('Preparation already running'), { statusCode: 409 });
  for (const [key, job] of jobs) if (job.state !== 'running') jobs.delete(key);
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    cwd: await resolvePath(cwd),
    env: getEnvironment(),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let finish!: () => void;
  const job: ProcessJob = {
    id,
    child,
    state: 'running',
    log: '',
    exitCode: null,
    done: new Promise((resolve) => {
      finish = resolve;
    }),
  };
  jobs.set(id, job);
  const append = (data: Buffer) => {
    job.log = (job.log + data.toString()).slice(-65536);
  };
  child.stdout!.on('data', append);
  child.stderr!.on('data', append);
  const timer = setTimeout(
    () => {
      job.log += '\nPreparation timed out after 30 minutes.';
      void cancelPreparation(id);
    },
    30 * 60 * 1000,
  );
  timer.unref();
  child.on('error', (e) => {
    job.log += e.message;
    job.state = 'failed';
    clearTimeout(timer);
    finish();
  });
  child.on('close', (code) => {
    job.exitCode = code;
    if (job.state === 'running') job.state = code === 0 ? 'succeeded' : 'failed';
    clearTimeout(timer);
    finish();
  });
  return snapshot(job);
}
export async function cancelPreparation(id?: string) {
  for (const job of jobs.values()) {
    if ((id && job.id !== id) || job.state !== 'running') continue;
    job.state = 'cancelled';
    const signal = (s: NodeJS.Signals) => {
      try {
        process.kill(-job.child.pid!, s);
      } catch {}
    };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), 1500);
    await job.done;
    clearTimeout(timer);
    // A shell can exit before its children. Kill any remaining members of its group.
    signal('SIGKILL');
  }
  return { ok: true };
}
export async function scaffold(files: { path: string; content: string }[]) {
  for (const file of files) {
    const target = await resolvePath(file.path, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, file.content, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return { ok: true };
}
export async function dependencyFingerprint(cwd: string, command: string) {
  const hash = createHash('sha256').update(cwd).update('\0').update(command);
  for (const name of [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'requirements.txt',
    'go.mod',
    'go.sum',
    'Cargo.toml',
    'Cargo.lock',
  ]) {
    try {
      hash.update(name).update(await fs.readFile(await resolvePath(path.posix.join(cwd, name))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return { fingerprint: hash.digest('hex') };
}
