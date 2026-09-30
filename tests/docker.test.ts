import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { defaultLimits, runtimeCatalog } from '@repellet/shared';
const enabled = process.env.RUN_DOCKER_TESTS === '1';
const id = randomUUID();
let worker: typeof import('../apps/worker/src/workspaces.js');
let configuration: typeof import('../apps/worker/src/config.js');
let images: typeof import('../apps/worker/src/images.js');
let terminalId = '';
async function json<T = any>(route: string, method = 'GET', body?: unknown): Promise<T> {
  return (await worker.bridgeRequest(id, route, method, body)).json() as Promise<T>;
}
function socket(route: string) {
  return worker.bridgeAddress(id).then(
    (address) =>
      new WebSocket(address.replace(/^http/, 'ws') + route, {
        headers: { authorization: `Bearer ${configuration.bridgeToken(id)}` },
      }),
  );
}
async function command(command: string, marker: string) {
  const ws = await socket(`/terminals/${terminalId}/connect`);
  const result = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Terminal command timed out: ' + output));
    }, 20000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'input', data: command + '\r' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'output') {
        output += msg.data;
        if (output.includes(marker)) {
          clearTimeout(timeout);
          resolve(output);
          ws.close();
        }
      }
    });
    ws.on('error', reject);
  });
  return result;
}
describe.skipIf(!enabled)('real Docker workspace integration', () => {
  beforeAll(async () => {
    worker = await import('../apps/worker/src/workspaces.js');
    configuration = await import('../apps/worker/src/config.js');
    images = await import('../apps/worker/src/images.js');
    try {
      await worker.ensureWorkspace(id, {
        runtimes: ['python', 'node'],
        limits: { ...defaultLimits, memoryMb: 1024 },
        environment: { TEST_SECRET: 'test-value' },
        previewTargetPort: 8000,
      });
    } catch (e) {
      console.error(images.buildLog(id));
      throw e;
    }
  }, 1200000);
  afterAll(async () => {
    if (worker) await worker.removeWorkspace(id);
  });
  it('combines Python and Node in a non-root, limited container', async () => {
    const state = await worker.inspect(id);
    expect(state!.Config.User).toBe('1000:1000');
    expect(state!.HostConfig.Privileged).toBe(false);
    expect(state!.HostConfig.CapDrop).toContain('ALL');
    expect(state!.HostConfig.PidsLimit).toBe(512);
    expect(state!.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    expect(state!.Mounts.some((m) => m.Destination.includes('docker.sock'))).toBe(false);
    const terminal = await json('/terminals', 'POST', { name: 'Integration' });
    terminalId = terminal.id;
    const output = await command(
      'python --version; node --version; printf \'RUNTIME_%s\\n\' "$TEST_SECRET"',
      'RUNTIME_test-value',
    );
    expect(output).toContain('Python 3.13');
    expect(output).toContain('v24.14');
  });
  it('preserves files across stops and container recreation', async () => {
    const file = await json('/file', 'PUT', {
      path: 'persistent.txt',
      content: 'kept across recreation',
      expectedHash: null,
    });
    await worker.stopWorkspace(id);
    await worker.ensureWorkspace(id, {
      runtimes: ['python', 'node'],
      limits: defaultLimits,
      environment: {},
      previewTargetPort: 8000,
    });
    expect((await json('/file?path=persistent.txt')).hash).toBe(file.hash);
    const state = await worker.inspect(id);
    await images.docker.getContainer(state!.Id).remove({ force: true });
    await worker.ensureWorkspace(id, {
      runtimes: ['python', 'node'],
      limits: defaultLimits,
      environment: {},
      previewTargetPort: 8000,
    });
    expect((await json('/file?path=persistent.txt')).content).toBe('kept across recreation');
    terminalId = (await json('/terminals', 'POST', { name: 'Reconnected' })).id;
  }, 120000);
  it('replays terminal output after reconnecting', async () => {
    await command("printf 'RECONNECT_%s\\n' OK", 'RECONNECT_OK');
    const ws = await socket(`/terminals/${terminalId}/connect`);
    const output = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data)).data));
      ws.once('error', reject);
    });
    ws.close();
    expect(output).toContain('RECONNECT_OK');
  });
  it('rejects external symlinks and stale writes', async () => {
    await command("ln -s /etc /workspace/escape; printf 'SYMLINK_%s\\n' READY", 'SYMLINK_READY');
    await expect(json('/file?path=escape/passwd')).rejects.toMatchObject({ statusCode: 403 });
    const before = await json('/file?path=persistent.txt');
    await json('/file', 'PUT', {
      path: 'persistent.txt',
      content: 'external change',
      expectedHash: before.hash,
    });
    await expect(
      json('/file', 'PUT', {
        path: 'persistent.txt',
        content: 'stale change',
        expectedHash: before.hash,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('runs an app, serves its port, and stops its process group', async () => {
    await json('/run', 'POST', { command: 'python -m http.server 8000 --bind 0.0.0.0', cwd: '' });
    const state = await worker.inspect(id);
    const binding = state!.NetworkSettings.Ports['8000/tcp']![0]!;
    let response: Response | undefined;
    for (let i = 0; i < 30; i++) {
      try {
        response = await fetch(`http://127.0.0.1:${binding.HostPort}/persistent.txt`);
        if (response.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe('external change');
    await json('/run/stop', 'POST');
  });
  it('provides Python and Node language-server initialization', async () => {
    for (const runtime of ['python', 'node']) {
      const ws = await socket('/language/' + runtime);
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(runtime + ' LSP timed out')), 20000);
        ws.on('open', () =>
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: { processId: null, rootUri: 'file:///workspace', capabilities: {} },
            }),
          ),
        );
        ws.on('message', (data) => {
          const msg = JSON.parse(String(data));
          if (msg.id === 1) {
            clearTimeout(timer);
            resolve(msg);
          }
        });
        ws.on('error', reject);
      });
      expect(result.result.capabilities).toBeTruthy();
      ws.close();
    }
  });
  it('formats Python and JavaScript using the project environment', async () => {
    expect(
      (await json('/format', 'POST', { path: 'example.py', content: 'x= [1,2]\n' })).content,
    ).toBe('x = [1, 2]\n');
    expect(
      (await json('/format', 'POST', { path: 'example.js', content: 'const x={a:1}' })).content,
    ).toBe('const x = { a: 1 };\n');
  });
  it('initializes Git and creates commits using the real files', async () => {
    await json('/git', 'POST', { action: 'init' });
    await json('/git', 'POST', { action: 'stage', paths: ['persistent.txt'] });
    await json('/git', 'POST', {
      action: 'commit',
      message: 'Initial commit',
      name: 'Test',
      email: 'test@repellet.local',
    });
    const status = await json('/git/status');
    expect(status.initialized).toBe(true);
    expect(status.entries.some((e: any) => e.path === 'persistent.txt')).toBe(false);
  });
  it('suspends execution at monitored storage limits but permits cleanup', async () => {
    await json('/limits', 'PUT', { storageMb: 0.001 });
    expect((await json('/usage')).exceeded).toBe(true);
    await expect(json('/terminals', 'POST', {})).rejects.toMatchObject({ statusCode: 507 });
    await worker.stopWorkspace(id);
    await worker.ensureWorkspace(id, {
      runtimes: ['python', 'node'],
      limits: { ...defaultLimits, storageMb: 0.001 },
      environment: {},
      previewTargetPort: 8000,
    });
    await expect(json('/terminals', 'POST', {})).rejects.toMatchObject({ statusCode: 507 });
    await json('/files/delete', 'POST', { path: 'persistent.txt' });
    await json('/limits', 'PUT', { storageMb: 256 });
    expect((await json('/usage')).exceeded).toBe(false);
  });
  it('recovers files after an unexpected container crash', async () => {
    await json('/file', 'PUT', { path: 'recovery.txt', content: 'recover me', expectedHash: null });
    const state = await worker.inspect(id);
    await images.docker.getContainer(state!.Id).kill();
    await worker.ensureWorkspace(id, {
      runtimes: ['python', 'node'],
      limits: defaultLimits,
      environment: {},
      previewTargetPort: 8000,
    });
    expect((await json('/file?path=recovery.txt')).content).toBe('recover me');
  }, 120000);
  it('preserves the old container and data when an environment build fails', async () => {
    const before = await worker.inspect(id);
    const cli = process.env.DOCKER_CLI;
    const python = runtimeCatalog.find((r) => r.id === 'python')! as { image: string };
    const originalImage = python.image;
    python.image = 'repellet/build-failure-test:' + randomUUID();
    process.env.DOCKER_CLI = process.platform === 'darwin' ? '/usr/bin/false' : '/bin/false';
    try {
      await expect(
        worker.ensureWorkspace(id, {
          runtimes: ['python', 'go'],
          limits: defaultLimits,
          environment: {},
          previewTargetPort: 8000,
          rebuild: true,
        }),
      ).rejects.toThrow('Environment build failed');
      expect((await worker.inspect(id))!.Image).toBe(before!.Image);
    } finally {
      python.image = originalImage;
      cli ? (process.env.DOCKER_CLI = cli) : delete process.env.DOCKER_CLI;
    }
    await worker.ensureWorkspace(id, {
      runtimes: ['python', 'node'],
      limits: defaultLimits,
      environment: {},
      previewTargetPort: 8000,
    });
    expect((await json('/file?path=recovery.txt')).content).toBe('recover me');
  }, 120000);
  it('recovers from memory exhaustion without losing workspace files', async () => {
    const state = await worker.inspect(id);
    await images.docker
      .getContainer(state!.Id)
      .update({ Memory: 256 * 1024 * 1024, MemorySwap: 256 * 1024 * 1024 });
    await json('/run', 'POST', {
      command: `exec /opt/repellet/node/bin/node -e 'const data=[];setInterval(()=>data.push(Buffer.alloc(32*1024*1024,1)),10)'`,
      cwd: '',
    });
    let exited = false;
    for (let i = 0; i < 100; i++) {
      const current = await worker.inspect(id);
      if (!current?.State.Running) {
        exited = true;
        break;
      }
      const sessions = await json('/terminals');
      if (sessions.find((s: any) => s.id === 'run')?.alive === false) {
        exited = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(exited).toBe(true);
    await worker.ensureWorkspace(id, {
      runtimes: ['python', 'node'],
      limits: defaultLimits,
      environment: {},
      previewTargetPort: 8000,
    });
    expect((await json('/file?path=recovery.txt')).content).toBe('recover me');
  }, 120000);
  it('builds Go and Rust together with their language servers', async () => {
    try {
      await worker.ensureWorkspace(id, {
        runtimes: ['go', 'rust'],
        limits: defaultLimits,
        environment: {},
        previewTargetPort: 8000,
        rebuild: true,
      });
    } catch (e) {
      console.error(images.buildLog(id));
      throw e;
    }
    terminalId = (await json('/terminals', 'POST', { name: 'Compiled languages' })).id;
    const output = await command(
      "go version; rustc --version; gopls version; rust-analyzer --version; printf 'COMPILED_%s\\n' READY",
      'COMPILED_READY',
    );
    expect(output).toContain('go1.26.1');
    expect(output).toContain('rustc 1.95.0');
    expect(output).toContain('rust-analyzer');
    expect(
      (
        await json('/format', 'POST', {
          path: 'main.go',
          content: 'package main\nfunc main(){println(1)}\n',
        })
      ).content,
    ).toContain('func main() { println(1) }');
    expect(
      (await json('/format', 'POST', { path: 'main.rs', content: 'fn main(){println!("hello");}' }))
        .content,
    ).toContain('fn main() {\n');
    expect((await json('/files')).some((e: any) => e.name === '.git')).toBe(false);
  }, 1200000);
});
