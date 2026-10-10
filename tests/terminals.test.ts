import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { beforeEach, it, expect, vi } from 'vitest';
const fake = vi.hoisted(() => ({ children: [] as any[], options: [] as any[] }));
vi.mock('node:child_process', () => ({ execFile: vi.fn((_cmd, _args, callback) => callback()) }));
vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: unknown, options: unknown) => {
    const child = {
      pid: 100 + fake.children.length,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => child.exit({ exitCode: 0 })),
      onData: (callback: any) => {
        child.data = callback;
      },
      onExit: (callback: any) => {
        child.exit = callback;
      },
      data: (_data: string) => {},
      exit: (_event: unknown) => {},
    };
    fake.children.push(child);
    fake.options.push(options);
    return child;
  }),
}));
vi.mock('../packages/bridge/src/files.js', () => ({
  root: '/workspace',
  resolvePath: async (path: string) => '/workspace/' + path,
}));
import {
  createTerminal,
  closeTerminal,
  stopTerminal,
  attachTerminal,
  info,
  terminals,
  setEnvironment,
  readTerminalOutput,
} from '../packages/bridge/src/terminals.js';
function socket() {
  return Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn() });
}

it('reads a live replay-buffer snapshot without attaching a terminal and hides output after stop', async () => {
  const id = randomUUID();
  await createTerminal('Main', 'node server.js', '', { id, kind: 'run' });
  fake.children[0].data('one\ntwo\n');
  expect(readTerminalOutput(id, 1)).toMatchObject({ running: true, text: 'two', truncated: true });
  expect(terminals.get(id)?.clients.size).toBe(0);
  await stopTerminal(id);
  expect(readTerminalOutput(id)).toEqual({ running: false });
});
beforeEach(() => {
  terminals.clear();
  fake.children = [];
  fake.options = [];
  setEnvironment({});
});
it('runs independent profiles with stable IDs and filtered project environments', async () => {
  setEnvironment({ SELECTED: 'yes', SECRET: 'hidden' });
  const a = randomUUID(),
    b = randomUUID(),
    actorId = randomUUID();
  await createTerminal('API', 'node server.js', '', {
    id: a,
    kind: 'run',
    actorId,
    environmentKeys: ['SELECTED'],
  });
  await createTerminal('Build', 'npm run build', '', { id: b, kind: 'task', environmentKeys: [] });
  await createTerminal('Duplicate receipt', 'node server.js', '', { id: a, kind: 'run' });
  expect(fake.children).toHaveLength(2);
  expect(fake.options[0].env).toMatchObject({ SELECTED: 'yes' });
  expect(fake.options[0].env).not.toHaveProperty('SECRET');
  expect(fake.options[1].env).not.toHaveProperty('SELECTED');
  expect(info()).toMatchObject([
    { id: a, actorId, status: 'running', kind: 'run' },
    { id: b, kind: 'task', status: 'running' },
  ]);
  fake.children[1].exit({ exitCode: 3 });
  expect(info()[1]).toMatchObject({ status: 'failed', exitCode: 3 });
  expect(info()[0]?.status).toBe('running');
});
it('enforces read-only attachment at the bridge and gives the first editor resize control', async () => {
  const session = await createTerminal();
  const first = socket(),
    second = socket(),
    viewer = socket();
  attachTerminal(first as unknown as WebSocket, session.id, true);
  attachTerminal(second as unknown as WebSocket, session.id, true);
  attachTerminal(viewer as unknown as WebSocket, session.id, false);
  viewer.emit('message', JSON.stringify({ type: 'input', data: 'rm -rf *' }));
  expect(viewer.close).toHaveBeenCalledWith(1008, 'Viewers cannot control terminals');
  expect(fake.children[0].write).not.toHaveBeenCalled();
  second.emit('message', JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  expect(fake.children[0].resize).not.toHaveBeenCalled();
  first.emit('message', JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  expect(fake.children[0].resize).toHaveBeenLastCalledWith(100, 30);
  first.emit('close');
  second.emit('message', JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  expect(fake.children[0].resize).toHaveBeenLastCalledWith(80, 24);
});
it('bounds per-process output and replays it to a new collaborator', async () => {
  const session = await createTerminal();
  fake.children[0].data('x'.repeat(2 * 1024 * 1024));
  expect(session.buffer.length).toBe(1024 * 1024);
  const client = socket();
  attachTerminal(client as unknown as WebSocket, session.id);
  expect(JSON.parse(client.send.mock.calls[0]![0]).data.length).toBe(1024 * 1024);
});

it('closing a terminal discards its session and replay and disconnects collaborators', async () => {
  const session = await createTerminal('Shell');
  const client = socket();
  attachTerminal(client as unknown as WebSocket, session.id);
  await closeTerminal(session.id);
  expect(info()).toEqual([]);
  expect(client.close).toHaveBeenCalledWith(1000, 'Terminal closed');
  await closeTerminal(session.id);
  expect(info()).toEqual([]);
});
it('stopping a managed process retains its output until explicitly closed', async () => {
  const id = randomUUID();
  await createTerminal('API', 'npm start', '', { id, kind: 'run' });
  fake.children[0].data('server output');
  await stopTerminal(id);
  expect(info()).toMatchObject([{ id, status: 'stopped', alive: false }]);
  expect(terminals.get(id)?.buffer).toContain('server output');
  await closeTerminal(id);
  expect(info()).toEqual([]);
});
