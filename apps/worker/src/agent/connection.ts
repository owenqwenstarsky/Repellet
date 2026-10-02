import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { ClientRequest, ServerNotification, ServerRequest } from '@repellet/codex-protocol';
export type Transport = {
  input: Writable;
  output: Readable;
  errors?: Readable;
  close: () => void | Promise<void>;
};
/** One initialized, bidirectional JSONL connection, independent of browser subscribers. */
export class CodexConnection extends EventEmitter {
  private nextId = 0;
  private inflight = new Map<
    number,
    { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private transport: Transport,
    private secrets: string[] = [],
  ) {
    super();
    const lines = createInterface({ input: transport.output });
    lines.on('line', (line) => {
      if (this.closed) return;
      if (Buffer.byteLength(line) > 16 * 1024 * 1024)
        return this.fail('Codex sent an oversized message');
      try {
        const message = JSON.parse(line);
        if (message.method) {
          this.emit(message.id === undefined ? 'notification' : 'request', message);
        } else {
          const pending = this.inflight.get(message.id);
          if (!pending) return;
          this.inflight.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error)
            pending.reject(
              new Error(this.safeMessage(message.error.message || 'Codex request failed')),
            );
          else pending.resolve(message.result);
        }
      } catch {
        this.fail('Codex sent an invalid protocol message');
      }
    });
    transport.input.on('error', () => this.fail('Codex process input closed'));
    transport.output.on('error', () => this.fail('Codex process output closed'));
    transport.output.on('end', () =>
      this.fail('Codex process exited. Reopen the agent to recover saved history.'),
    );
    // Drain stderr without logging credentials or provider response bodies.
    transport.errors?.resume();
  }
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'repellet', title: 'Repellet', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }
  call(method: ClientRequest['method'], params: unknown = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Codex process is unavailable'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        reject(
          Object.assign(
            new Error('Codex response was lost. Refresh status and history before continuing.'),
            { uncertain: true },
          ),
        );
        // Never leave an unknown mutation executing behind a new connection.
        this.fail(
          'Codex response timed out. Saved history can be recovered; prompts are never replayed.',
        );
      }, 60000);
      timer.unref();
      this.inflight.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  respond(id: ServerRequest['id'], result: unknown) {
    this.send({ id, result });
  }
  reject(id: ServerRequest['id'], message: string) {
    this.send({ id, error: { code: -32601, message } });
  }
  private safeMessage(message: string) {
    for (const secret of this.secrets)
      if (secret) message = message.replaceAll(secret, '[redacted]');
    return message;
  }
  private send(message: unknown) {
    if (this.closed) throw new Error('Codex process is unavailable');
    this.transport.input.write(JSON.stringify(message) + '\n');
  }
  private fail(message: string) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.inflight.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.inflight.clear();
    this.emit('failure', message);
    void this.shutdown().catch(() => {});
  }
  private shutdown() {
    return (this.closing ||= Promise.resolve().then(() => this.transport.close()));
  }
  async close() {
    this.fail('Agent stopped. Reopen it to recover saved history.');
    await this.shutdown();
  }
}
export interface CodexConnection {
  on(event: 'notification', listener: (event: ServerNotification) => void): this;
  on(event: 'request', listener: (event: ServerRequest) => void): this;
  on(event: 'failure', listener: (message: string) => void): this;
}
