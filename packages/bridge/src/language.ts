import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WebSocket } from 'ws';
import { getEnvironment } from './terminals.js';
import { root } from './files.js';
const processes = new Set<ChildProcessWithoutNullStreams>();
const commands: Record<string, [string, string[]]> = {
  python: [
    '/opt/repellet/node/bin/node',
    ['/opt/language-tools/node_modules/pyright/langserver.index.js', '--stdio'],
  ],
  node: [
    '/opt/repellet/node/bin/node',
    ['/opt/language-tools/node_modules/typescript-language-server/lib/cli.mjs', '--stdio'],
  ],
  go: ['/opt/go-tools/bin/gopls', ['serve']],
  rust: ['/opt/rust/cargo/bin/rust-analyzer', []],
};
export function attachLanguage(ws: WebSocket, language: string) {
  const command = commands[language];
  if (!command) {
    ws.close(1008, 'Unsupported language');
    return;
  }
  const child = spawn(command[0], command[1], { cwd: root, env: getEnvironment(), stdio: 'pipe' });
  processes.add(child);
  let buffer = Buffer.alloc(0);
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const length = Number(
        /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
      );
      if (!Number.isFinite(length) || length > 16 * 1024 * 1024) {
        ws.close(1011, 'Invalid language-server response');
        return;
      }
      if (buffer.length < end + 4 + length) break;
      const message = buffer.subarray(end + 4, end + 4 + length);
      buffer = buffer.subarray(end + 4 + length);
      if (ws.readyState === 1) ws.send(message.toString());
    }
  });
  child.stderr.on('data', (data) => (stderr = (stderr + String(data)).slice(-4096)));
  child.on('error', (e) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ method: 'repellet/error', params: { message: e.message } }));
      ws.close(1011, 'Language service unavailable');
    }
  });
  child.on('exit', () => {
    processes.delete(child);
    if (ws.readyState === 1) {
      if (stderr)
        ws.send(JSON.stringify({ method: 'repellet/error', params: { message: stderr } }));
      ws.close(1000, 'Language service stopped');
    }
  });
  ws.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw));
      if (message.method === 'workspace/executeCommand') return;
      const body = JSON.stringify(message);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    } catch {}
  });
  ws.on('close', () => {
    child.kill('SIGTERM');
    processes.delete(child);
  });
}
export function stopLanguages() {
  for (const child of processes) child.kill('SIGTERM');
  processes.clear();
}
