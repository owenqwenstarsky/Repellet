import { PassThrough } from 'node:stream';
import { docker, BASE_IMAGE } from '../images.js';
import { containerName, volumeName, inspect, bridgeRequest } from '../workspaces.js';
import type { AgentPrivateSettings } from '@repellet/shared';
import { CodexConnection } from './connection.js';
const toml = (value: string) => JSON.stringify(value);
export function codexArguments(settings: AgentPrivateSettings) {
  const args = [
    'app-server',
    '-c',
    'cli_auth_credentials_store="ephemeral"',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="danger-full-access"',
    '-c',
    'shell_environment_policy.inherit="all"',
    '-c',
    'shell_environment_policy.exclude=["REPELLET_AGENT_API_KEY","BRIDGE_TOKEN","CODEX_HOME"]',
  ];
  if (settings.mode === 'custom')
    args.push(
      '-c',
      'model_provider="repellet"',
      '-c',
      'model=' + toml(settings.model),
      '-c',
      'model_providers.repellet=' +
        `{name="Repellet custom API",base_url=${toml(settings.baseUrl)},env_key="REPELLET_AGENT_API_KEY",wire_api="responses"}`,
    );
  if (settings.effort) args.push('-c', 'model_reasoning_effort=' + toml(settings.effort));
  return args;
}
async function execAgent(id: string, command: string[], allowMissing = false) {
  const execution = await docker
    .getContainer(containerName(id))
    .exec({ User: '1001:1000', Cmd: command, AttachStdout: true, AttachStderr: true });
  const stream = await execution.start({ hijack: true, stdin: false });
  stream.resume();
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const result = await execution.inspect();
  if (result.ExitCode !== 0 && !(allowMissing && result.ExitCode === 1))
    throw new Error('Could not prepare private agent state and workspace permissions');
}
const kills = new Map<string, Promise<void>>();
export async function killProjectAgent(id: string) {
  const current = (kills.get(id) || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      if (!(await inspect(id))?.State.Running) return;
      try {
        await execAgent(id, ['pkill', '-KILL', '--ignore-ancestors', '-u', '1001'], true);
      } catch (error) {
        // Stop/delete and worker shutdown can race the Docker exec. A stopped or
        // removed container has already terminated all its agent processes.
        if ((await inspect(id))?.State.Running) throw error;
      }
    });
  kills.set(id, current);
  try {
    await current;
  } finally {
    if (kills.get(id) === current) kills.delete(id);
  }
}
export async function startProjectProcess(id: string, settings: AgentPrivateSettings) {
  if (!(await inspect(id))?.State.Running)
    throw Object.assign(new Error('Start the workspace to load agent conversations'), {
      statusCode: 409,
    });
  await killProjectAgent(id);
  // Existing workspaces receive reciprocal access once before the first run of this process.
  const helper = await docker.createContainer({
    Image: BASE_IMAGE,
    User: '0:0',
    Entrypoint: ['/bin/sh', '-c'],
    HostConfig: {
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
      Mounts: [
        { Type: 'volume', Source: volumeName(id), Target: '/workspace' },
        { Type: 'volume', Source: volumeName(id, 'agent'), Target: '/home/agent' },
      ],
    },
    Labels: { 'repellet.helper': 'true' },
    Cmd: [
      'mkdir -p /home/agent/.codex && chown 1001:1001 /home/agent /home/agent/.codex && chmod 700 /home/agent /home/agent/.codex && chgrp -R 1000 /workspace && chmod g+rwX /workspace && find /workspace -type d -exec chmod g+s {} + && setfacl -R -m g:1000:rwX /workspace && find /workspace -type d -exec setfacl -m d:g:1000:rwx,d:m:rwx {} +',
    ],
  });
  try {
    await helper.start();
    if ((await helper.wait()).StatusCode !== 0)
      throw new Error('Could not prepare agent filesystem permissions');
  } finally {
    await helper.remove({ force: true }).catch(() => {});
  }
  const environment = (await (await bridgeRequest(id, '/environment')).json()) as Record<
    string,
    string
  >;
  const container = docker.getContainer(containerName(id));
  const current = await container.inspect();
  const base: Record<string, string> = Object.fromEntries(
    (current.Config.Env || []).map((entry) => {
      const index = entry.indexOf('=');
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  for (const key of [
    'BRIDGE_TOKEN',
    'REPELLET_AGENT_API_KEY',
    'WORKER_TOKEN',
    'CODEX_HOME',
    'HOME',
    'CARGO_HOME',
  ])
    delete environment[key];
  const safeEnv = {
    ...environment,
    PATH: base.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/agent',
    CODEX_HOME: '/home/agent/.codex',
    ...(base.RUSTUP_HOME
      ? { RUSTUP_HOME: base.RUSTUP_HOME, CARGO_HOME: '/home/agent/.cargo' }
      : {}),
    BRIDGE_TOKEN: '',
    ...(settings.mode === 'custom' ? { REPELLET_AGENT_API_KEY: settings.apiKey! } : {}),
  };
  // Docker's Exec API carries the key in Env, never in command arguments or a shared file.
  const execution = await container.exec({
    User: '1001:1000',
    WorkingDir: '/workspace',
    Cmd: [
      '/opt/repellet/node/bin/node',
      '/opt/repellet/agent-launch.cjs',
      ...codexArguments(settings),
    ],
    Env: Object.entries(safeEnv).map(([key, value]) => `${key}=${value}`),
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = await execution.start({ hijack: true, stdin: true });
  const output = new PassThrough(),
    errors = new PassThrough();
  docker.modem.demuxStream(stream, output, errors);
  stream.on('end', () => output.end());
  stream.on('error', () => output.destroy(new Error('Docker exec disconnected')));
  return new CodexConnection(
    {
      input: stream,
      output,
      errors,
      close: async () => {
        stream.destroy();
        await killProjectAgent(id);
      },
    },
    settings.apiKey ? [settings.apiKey] : [],
  );
}
export async function projectAgentBytes(id: string) {
  // Bridge cannot enter the private home. Measure as the agent via an internal Docker operation.
  if (!(await inspect(id))?.State.Running) return 0;
  const execution = await docker.getContainer(containerName(id)).exec({
    User: '1001:1000',
    Cmd: ['du', '-sb', '/home/agent'],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await execution.start({ hijack: true, stdin: false });
  const output = new PassThrough(),
    errors = new PassThrough();
  docker.modem.demuxStream(stream, output, errors);
  errors.resume();
  let text = '';
  output.on('data', (chunk) => {
    text += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  if ((await execution.inspect()).ExitCode !== 0) throw new Error('Cannot measure agent storage');
  const bytes = Number(text.split(/\s/)[0]);
  if (!Number.isFinite(bytes)) throw new Error('Invalid agent storage measurement');
  return bytes;
}
