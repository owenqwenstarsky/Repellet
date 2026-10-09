import Docker from 'dockerode';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runtimeCatalog, type Runtime } from '@repellet/shared';
import { config } from './config.js';
export const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
});
export const BASE_IMAGE = 'repellet/workspace-base:0.6.1';
let baseBuild: Promise<void> | null = null;
const builds = new Map<string, Promise<string>>();
const logs = new Map<string, string>();
export const buildLog = (id: string) => logs.get(id) || '';
async function exists(tag: string) {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}
// A private CLI configuration avoids consuming the host's registry credentials or invoking desktop keychain helpers.
async function build(context: string, dockerfile: string, tag: string, onLog: (s: string) => void) {
  const cliConfig = await fs.mkdtemp(path.join(os.tmpdir(), 'repellet-docker-'));
  await fs.writeFile(
    path.join(cliConfig, 'config.json'),
    JSON.stringify({
      auths: {},
      ...(process.platform === 'darwin'
        ? { cliPluginsExtraDirs: ['/Applications/Docker.app/Contents/Resources/cli-plugins'] }
        : {}),
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.env.DOCKER_CLI || 'docker',
        [
          '--config',
          cliConfig,
          '--host',
          `unix://${process.env.DOCKER_SOCKET || '/var/run/docker.sock'}`,
          'build',
          '--progress=plain',
          '--tag',
          tag,
          '--file',
          dockerfile,
          context,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOCKER_BUILDKIT: '1' } },
      );
      let tail = '';
      const output = (data: Buffer) => {
        const text = data.toString();
        tail = (tail + text).slice(-4096);
        onLog(text);
      };
      child.stdout.on('data', output);
      child.stderr.on('data', output);
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(
          new Error('Environment build exceeded 30 minutes; retry after checking the worker logs'),
        );
      }, 30 * 60000);
      child.on('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.on('exit', (code) => {
        clearTimeout(timeout);
        code === 0
          ? resolve()
          : reject(new Error(`Environment build failed: ${tail.slice(-1500)}`));
      });
    });
  } finally {
    await fs.rm(cliConfig, { recursive: true, force: true });
  }
}
export async function ensureBase(onLog: (s: string) => void = () => {}) {
  if (await exists(BASE_IMAGE)) return;
  if (!baseBuild)
    baseBuild = build(
      config.context,
      path.join(config.context, 'docker/workspace.Dockerfile'),
      BASE_IMAGE,
      onLog,
    );
  try {
    await baseBuild;
  } finally {
    baseBuild = null;
  }
}
export function runtimeDockerfile(runtimes: Runtime[]) {
  const stages = runtimes
    .map((r) => `FROM ${runtimeCatalog.find((c) => c.id === r)!.image} AS ${r}`)
    .join('\n');
  const parts = [stages, `FROM ${BASE_IMAGE}`, 'USER root'];
  if (runtimes.includes('python'))
    parts.push(
      'COPY --from=python /usr/local /usr/local',
      'RUN echo /usr/local/lib > /etc/ld.so.conf.d/python.conf && ldconfig',
      'RUN python -m pip install --no-cache-dir ruff==0.16.9',
    );
  if (runtimes.includes('node'))
    parts.push(
      'COPY --from=node /usr/local/bin/node /usr/local/bin/node',
      'COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules',
      'RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx',
    );
  if (runtimes.includes('go'))
    parts.push(
      'COPY --from=go /usr/local/go /usr/local/go',
      'ENV PATH="/usr/local/go/bin:/opt/go-tools/bin:${PATH}"',
      'RUN GOPATH=/opt/go-tools go install golang.org/x/tools/gopls@v0.21.1',
    );
  if (runtimes.includes('rust'))
    parts.push(
      'COPY --from=rust /usr/local/cargo /opt/rust/cargo',
      'COPY --from=rust /usr/local/rustup /opt/rust/rustup',
      'ENV RUSTUP_HOME=/opt/rust/rustup',
      'ENV CARGO_HOME=/home/workspace/.cargo',
      'ENV PATH="/opt/rust/cargo/bin:/home/workspace/.cargo/bin:${PATH}"',
      'RUN CARGO_HOME=/opt/rust/cargo /opt/rust/cargo/bin/rustup component add rust-analyzer rustfmt',
    );
  parts.push('USER workspace', 'WORKDIR /workspace');
  return parts.join('\n') + '\n';
}
export async function ensureImage(id: string, runtimes: Runtime[], resetLog = true) {
  const append = (text: string) => logs.set(id, ((logs.get(id) || '') + text).slice(-256 * 1024));
  if (resetLog) logs.set(id, 'Preparing project environment…\n');
  await ensureBase(append);
  const base = await docker.getImage(BASE_IMAGE).inspect();
  const dockerfile = runtimeDockerfile([...runtimes].sort()) + `# base image: ${base.Id}\n`;
  const tag = `repellet/workspace:${createHash('sha256').update(dockerfile).digest('hex').slice(0, 16)}`;
  if (await exists(tag)) {
    append('Using cached environment.\n');
    return tag;
  }
  if (!builds.has(tag))
    builds.set(
      tag,
      (async () => {
        const context = await fs.mkdtemp(path.join(os.tmpdir(), 'repellet-build-'));
        try {
          await fs.writeFile(path.join(context, 'Dockerfile'), dockerfile);
          await build(context, path.join(context, 'Dockerfile'), tag, append);
          return tag;
        } finally {
          await fs.rm(context, { recursive: true, force: true });
        }
      })(),
    );
  else append('Waiting for another project to build the same environment…\n');
  try {
    return await builds.get(tag)!;
  } finally {
    builds.delete(tag);
  }
}
