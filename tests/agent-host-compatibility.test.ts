import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { AgentConnection } from '../apps/worker/src/agent/connection.js';
function fixture(result: unknown) {
  const input = new PassThrough(),
    output = new PassThrough();
  const close = vi.fn();
  const connection = new AgentConnection({ input, output, close });
  input.on('data', (data) => {
    const request = JSON.parse(data.toString());
    if (request.id) output.write(JSON.stringify({ id: request.id, result }) + '\n');
  });
  return connection;
}
it('requires the new adapter capability before starting model work in an older workspace', async () => {
  const old = fixture({ version: '1.1.0' });
  await expect(old.initialize(true)).rejects.toThrow('Stop and start this workspace');
  await old.close();
  const updated = fixture({ apiSelection: true });
  await updated.initialize(true);
  await updated.close();
});
it('redacts newly refreshed credentials from transport errors', async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const connection = new AgentConnection({ input, output, close: vi.fn() });
  connection.addSecrets('refreshed-private-token');
  input.on('data', (data) => {
    const request = JSON.parse(data.toString());
    output.write(
      JSON.stringify({
        id: request.id,
        error: { message: 'Failed with refreshed-private-token' },
      }) + '\n',
    );
  });
  await expect(connection.call('account/read')).rejects.toThrow('Failed with [redacted]');
  await connection.close();
});

it('registers proxy models alongside ChatGPT entirely in memory and removes both credentials from tool environments', async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { runInNewContext } = await import('node:vm');
  const h = createRequire(import.meta.url)('../docker/pi-session.cjs');
  const source = readFileSync(new URL('../docker/pi-host.cjs', import.meta.url), 'utf8');
  const credentials: any[] = [];
  const runtime = {
    getModels: () => [],
    registerProvider: vi.fn(),
    setRuntimeApiKey: vi.fn(async () => {}),
  };
  const sdk = {
    ModelRuntime: {
      create: vi.fn(async (options: any) => {
        credentials.push(options.credentials);
        return runtime;
      }),
    },
  };
  const fs = { mkdirSync: vi.fn(), readdirSync: () => [], rmSync: vi.fn(), writeFileSync: vi.fn() };
  const env = {
    REPELLET_PI_PROVIDER: 'openai-codex',
    REPELLET_PI_BASE_URL: 'https://global.invalid/v1',
    REPELLET_PI_MODELS: '["allowed"]',
    REPELLET_AGENT_API_KEY: 'global-private-key',
    REPELLET_CHATGPT_ACCESS_TOKEN: 'chatgpt-private-token',
    REPELLET_CHATGPT_ACCOUNT_ID: 'account',
    WORKER_TOKEN: 'control-private-key',
    BRIDGE_TOKEN: 'bridge-private-key',
  };
  const service = runInNewContext(
    source.slice(0, source.lastIndexOf('main().catch(')) + '\n({ main, handle });',
    {
      require: (name: string) =>
        (
          ({
            'node:fs': fs,
            'node:path': path,
            'node:crypto': { randomUUID: () => 'id' },
            './pi-session.cjs': {
              ...h,
              sdk: async () => sdk,
              readIndex: () => ({ sessions: [] }),
              writeIndex: vi.fn(),
            },
          }) as any
        )[name],
      process: {
        env,
        umask: vi.fn(),
        argv: [],
        stdin: { setEncoding: vi.fn(), on: vi.fn() },
        stdout: { write: vi.fn() },
      },
      setTimeout,
      clearTimeout,
      Buffer,
    },
  );
  await service.main();
  expect(env).toEqual({});
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(sdk.ModelRuntime.create).toHaveBeenCalledWith(
    expect.objectContaining({ modelsPath: null, refreshOnCreate: false }),
  );
  expect(runtime.registerProvider).toHaveBeenCalledWith(
    'repellet',
    expect.objectContaining({
      baseUrl: 'https://global.invalid/v1',
      api: 'openai-responses',
      models: [expect.objectContaining({ id: 'allowed' })],
    }),
  );
  expect(runtime.setRuntimeApiKey).toHaveBeenCalledWith('repellet', 'global-private-key');
  expect(await credentials[0].list()).toEqual([{ providerId: 'openai-codex', type: 'oauth' }]);
});
