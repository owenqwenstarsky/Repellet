import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
};
export const terminals = new Map<string, Session>();
let environment: Record<string, string> = {};
export function setEnvironment(value: Record<string, string>) {
  environment = { ...value };
}
export const projectEnvironment = () => ({ ...environment });
export const getEnvironment = () => ({ ...process.env, ...environment }) as Record<string, string>;
export function info() {
  return [...terminals.values()].map(({ id, name, isRun, alive }) => ({ id, name, isRun, alive }));
}
export async function createTerminal(name = 'Terminal', command?: string, cwd = '') {
  if ([...terminals.values()].filter((t) => t.alive).length >= 12)
    throw Object.assign(new Error('Maximum of 12 terminal sessions'), { statusCode: 409 });
  if (command) await stopTerminal('run');
  const directory = await resolvePath(cwd || '');
  const child = pty.spawn('/bin/bash', command ? ['-c', command] : ['--noprofile'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd: directory,
    env: {
      ...getEnvironment(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PS1: '\\[\\e[38;5;110m\\]workspace\\[\\e[0m\\]:\\w \\$ ',
    },
  });
  const session: Session = {
    id: command ? 'run' : randomUUID(),
    name,
    isRun: !!command,
    alive: true,
    process: child,
    buffer: '',
    clients: new Set(),
  };
  if (command && terminals.has('run')) {
    for (const ws of terminals.get('run')!.clients) ws.close(1012, 'Run restarted');
    await stopTerminal('run');
  }
  terminals.set(session.id, session);
  child.onData((data) => {
    session.buffer = (session.buffer + data).slice(-1024 * 1024);
    for (const ws of session.clients)
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data }));
  });
  child.onExit(({ exitCode, signal }) => {
    session.alive = false;
    const data = `\r\n\x1b[90m[Process exited${signal ? ` · signal ${signal}` : ` · code ${exitCode}`} ]\x1b[0m\r\n`;
    session.buffer += data;
    for (const ws of session.clients)
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'output', data }));
        ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      }
  });
  return session;
}
export async function stopTerminal(id: string) {
  const session = terminals.get(id);
  if (session?.alive) {
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
export function attachTerminal(ws: WebSocket, id: string) {
  const session = terminals.get(id);
  if (!session) {
    ws.close(1008, 'Terminal does not exist');
    return;
  }
  session.clients.add(ws);
  ws.send(JSON.stringify({ type: 'output', data: session.buffer }));
  ws.send(JSON.stringify({ type: 'status', alive: session.alive }));
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'input' && typeof message.data === 'string' && session.alive)
        session.process.write(message.data.slice(0, 65536));
      if (
        message.type === 'resize' &&
        Number.isInteger(message.cols) &&
        Number.isInteger(message.rows)
      )
        session.process.resize(
          Math.max(2, Math.min(500, message.cols)),
          Math.max(2, Math.min(200, message.rows)),
        );
    } catch {}
  });
  ws.on('close', () => session.clients.delete(ws));
}
export async function stopAll() {
  await Promise.all([...terminals.keys()].map(stopTerminal));
}
