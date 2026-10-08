import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { root, resolvePath } from './files.js';
export type Session = {
  id: string;
  name: string;
  isRun: boolean;
  alive: boolean;
  process: pty.IPty;
  buffer: string;
  clients: Set<WebSocket>;
  kind: 'run' | 'task' | 'terminal';
  actorId?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  stopped?: boolean;
};
export const processEvents = new EventEmitter();
export const terminals = new Map<string, Session>();
let environment: Record<string, string> = {};
export function setEnvironment(value: Record<string, string>) {
  environment = { ...value };
}
export const projectEnvironment = () => ({ ...environment });
export const getEnvironment = () => ({ ...process.env, ...environment }) as Record<string, string>;
export function info() {
  return [...terminals.values()].map(
    ({
      id,
      name,
      isRun,
      alive,
      process,
      kind,
      actorId,
      startedAt,
      finishedAt,
      exitCode,
      stopped,
    }) => ({
      id,
      name,
      isRun,
      alive,
      pid: process.pid,
      kind,
      actorId,
      startedAt,
      finishedAt,
      exitCode,
      status: alive ? 'running' : stopped ? 'stopped' : exitCode === 0 ? 'exited' : 'failed',
    }),
  );
}
type TerminalOptions = {
  id?: string;
  kind?: 'run' | 'task' | 'terminal';
  actorId?: string;
  environmentKeys?: string[];
};
const creating = new Map<string, Promise<Session>>();
const stoppedProcessIds = new Set<string>();
export async function createTerminal(
  name = 'Terminal',
  command?: string,
  cwd = '',
  options: TerminalOptions = {},
) {
  if (!options.id) return spawnTerminal(name, command, cwd, options);
  const id = options.id;
  if (stoppedProcessIds.has(id))
    throw Object.assign(new Error('This process was already stopped'), { statusCode: 409 });
  if (!creating.has(id)) creating.set(id, spawnTerminal(name, command, cwd, options));
  const pending = creating.get(id)!;
  try {
    return await pending;
  } finally {
    if (creating.get(id) === pending) creating.delete(id);
  }
}
async function spawnTerminal(
  name: string,
  command: string | undefined,
  cwd: string,
  options: TerminalOptions,
) {
  if (options.id && terminals.has(options.id)) return terminals.get(options.id)!;
  if ([...terminals.values()].filter((t) => t.alive).length >= 12)
    throw Object.assign(new Error('Maximum of 12 terminal sessions'), { statusCode: 409 });
  if (command && !options.id) await stopTerminal('run');
  const directory = await resolvePath(cwd || '');
  const child = pty.spawn('/bin/bash', command ? ['-c', command] : ['--noprofile'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd: directory,
    env: {
      ...process.env,
      ...(options.environmentKeys
        ? Object.fromEntries(
            Object.entries(environment).filter(([key]) => options.environmentKeys!.includes(key)),
          )
        : environment),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PS1: '\\[\\e[38;5;110m\\]workspace\\[\\e[0m\\]:\\w \\$ ',
    },
  });
  const session: Session = {
    id: options.id || (command ? 'run' : randomUUID()),
    name,
    isRun: options.kind ? options.kind === 'run' : !!command,
    alive: true,
    process: child,
    buffer: '',
    clients: new Set(),
    kind: options.kind || (command ? 'run' : 'terminal'),
    actorId: options.actorId,
    startedAt: new Date().toISOString(),
  };
  if (command && !options.id && terminals.has('run')) {
    for (const ws of terminals.get('run')!.clients) ws.close(1012, 'Run restarted');
    await stopTerminal('run');
  }
  terminals.set(session.id, session);
  processEvents.emit(
    'change',
    info().find((entry) => entry.id === session.id),
  );
  child.onData((data) => {
    session.buffer = (session.buffer + data).slice(-1024 * 1024);
    for (const ws of session.clients)
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
  });
  child.onExit(({ exitCode, signal }) => {
    session.alive = false;
    session.exitCode = exitCode;
    session.finishedAt = new Date().toISOString();
    processEvents.emit(
      'change',
      info().find((entry) => entry.id === session.id),
    );
    const data = `\r\n\x1b[90m[Process exited${signal ? ` · signal ${signal}` : ` · code ${exitCode}`} ]\x1b[0m\r\n`;
    session.buffer = (session.buffer + data).slice(-1024 * 1024);
    for (const ws of session.clients)
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'output', data }));
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      }
    const retired = [...terminals.values()].filter((entry) => !entry.alive);
    for (const entry of retired.slice(0, Math.max(0, retired.length - 50))) {
      for (const client of entry.clients) client.close(1012, 'Terminal output retention expired');
      terminals.delete(entry.id);
    }
  });
  return session;
}
export async function stopTerminal(id: string) {
  if (/^[0-9a-f-]{36}$/.test(id)) {
    stoppedProcessIds.add(id);
    if (stoppedProcessIds.size > 5000)
      stoppedProcessIds.delete(stoppedProcessIds.values().next().value!);
  }
  await creating.get(id)?.catch(() => {});
  const session = terminals.get(id);
  if (session?.alive) {
    session.stopped = true;
    await new Promise<void>((resolve) =>
      execFile('pkill', ['-TERM', '-s', String(session.process.pid)], () => resolve()),
    );
    try {
      session.process.kill('SIGTERM');
    } catch {}
    const pid = session.process.pid;
    const kill = () =>
      new Promise<void>((resolve) =>
        execFile('pkill', ['-KILL', '-s', String(pid)], () => {
          try {
            session.process.kill('SIGKILL');
          } catch {}
          resolve();
        }),
      );
    const deadline = Date.now() + 1500;
    while (session.alive && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    await kill();
    const exitDeadline = Date.now() + 3000;
    while (session.alive && Date.now() < exitDeadline) await new Promise((r) => setTimeout(r, 25));
    if (session.alive) throw new Error('Previous process did not exit; retry Stop app');
  }
}
// Closing a tab is different from stopping a managed process: discard its replay session.
export async function closeTerminal(id: string) {
  await stopTerminal(id);
  const session = terminals.get(id);
  if (!session) return;
  for (const client of session.clients) client.close(1000, 'Terminal closed');
  terminals.delete(id);
}
const writableClients = new WeakMap<Session, Set<WebSocket>>();
export function attachTerminal(ws: WebSocket, id: string, editable = true) {
  const session = terminals.get(id);
  if (!session) {
    ws.close(1008, 'Terminal does not exist');
    return;
  }
  session.clients.add(ws);
  const writers = writableClients.get(session) || new Set<WebSocket>();
  writableClients.set(session, writers);
  if (editable) writers.add(ws);
  ws.send(JSON.stringify({ type: 'output', data: session.buffer }));
  ws.send(JSON.stringify({ type: 'status', alive: session.alive }));
  ws.on('message', (raw) => {
    if (!editable) {
      ws.close(1008, 'Viewers cannot control terminals');
      return;
    }
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'input' && typeof message.data === 'string' && session.alive)
        session.process.write(message.data.slice(0, 65536));
      if (
        message.type === 'resize' &&
        writers.values().next().value === ws &&
        Number.isInteger(message.cols) &&
        Number.isInteger(message.rows)
      )
        session.process.resize(
          Math.max(2, Math.min(500, message.cols)),
          Math.max(2, Math.min(200, message.rows)),
        );
    } catch {}
  });
  ws.on('close', () => {
    session.clients.delete(ws);
    writers.delete(ws);
  });
}
export async function stopAll() {
  await Promise.all([...terminals.keys()].map(stopTerminal));
}
