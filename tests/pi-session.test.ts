import { beforeEach, afterEach, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const h = createRequire(import.meta.url)('../docker/pi-session.cjs');
it('supplies image and text-file contents to Pi but keeps references in live and saved transcripts', () => {
  const image = {
    id: 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12),
    kind: 'image',
    name: 'image.png',
    mimeType: 'image/png',
    bytes: 3,
  };
  const pasted = {
    id: 'b'.repeat(8) + '-bbbb-4bbb-8bbb-' + 'b'.repeat(12),
    kind: 'text',
    name: 'pasted-text.txt',
    label: 'Pasted text',
    mimeType: 'text/plain',
    bytes: 5,
  };
  const input = [
    { type: 'text', text: 'Inspect this' },
    { type: 'attachment', attachment: image },
    { type: 'attachment', attachment: pasted },
  ];
  const prepared = h.prepareInput(input, (id: string) =>
    Buffer.from(id === image.id ? 'png' : 'hello'),
  );
  expect(prepared.images).toEqual([
    { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' },
  ]);
  expect(prepared.text).toContain('Attached text file: "Pasted text"\nhello');
  const message = {
    role: 'user',
    timestamp: 9,
    content: [{ type: 'text', text: prepared.text }, ...prepared.images],
  };
  const queue = [{ text: prepared.text, input }];
  h.attachInputMetadata(message, queue);
  expect(queue).toEqual([]);
  const live = h.messageItems(message)[0];
  expect(live.content).toEqual(input);
  expect(JSON.stringify(live)).not.toContain(prepared.images[0].data);
  const manager = {
    getBranch: () => [
      { type: 'custom', customType: 'repellet.turn', data: { id: 'turn' } },
      { type: 'message', id: 'message', message: JSON.parse(JSON.stringify(message)) },
    ],
  };
  expect(h.transcript(manager)[0].items[0]).toEqual(live);
  expect(() => h.prepareInput(input, () => Buffer.from('wrong-size'))).toThrow('incomplete');
});

it('retains attachment references in Pi session entries without including image payloads in the public transcript', async () => {
  const { SessionManager } = await h.sdk();
  const manager = SessionManager.inMemory('/workspace');
  const input = [
    {
      type: 'attachment',
      attachment: {
        id: 'attachment-id',
        kind: 'image',
        name: 'shot.png',
        mimeType: 'image/png',
        bytes: 3,
      },
    },
  ];
  manager.appendCustomEntry('repellet.turn', { id: 'turn' });
  manager.appendMessage({
    role: 'user',
    timestamp: 1,
    content: [{ type: 'image', mimeType: 'image/png', data: 'private-base64-payload' }],
    repelletInput: input,
  });
  expect(h.transcript(manager)[0].items[0].content).toEqual(input);
  expect(JSON.stringify(h.transcript(manager))).not.toContain('private-base64-payload');
});

it('associates steering attachments independently and preserves image-only user messages', () => {
  const input = [{ type: 'attachment', attachment: { id: 'image-id', kind: 'image' } }];
  const queue = [
    { text: 'First prompt', input: [{ type: 'text', text: 'First prompt' }] },
    { text: '', input },
  ];
  const message = {
    role: 'user',
    timestamp: 1,
    content: [{ type: 'image', mimeType: 'image/png', data: 'large-base64' }],
  };
  h.attachInputMetadata(message, queue);
  expect(h.messageItems(message)[0].content).toEqual(input);
  expect(queue).toHaveLength(1);
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'First prompt' }] };
  h.attachInputMetadata(assistant, queue);
  expect(assistant).not.toHaveProperty('repelletInput');
});
let root = '';
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'repellet-pi-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('atomically stores names and archive metadata and refuses a damaged index', async () => {
  const file = path.join(root, 'index.json');
  expect(h.readIndex(file)).toEqual({ version: 1, sessions: [] });
  h.writeIndex(file, {
    version: 1,
    sessions: [{ threadId: 'one', displayName: 'Saved', archived: true }],
  });
  expect(h.readIndex(file).sessions[0]).toMatchObject({ displayName: 'Saved', archived: true });
  await writeFile(file, 'broken');
  expect(() => h.readIndex(file)).toThrow('unreadable');
});
it('translates separate assistant messages and cumulative command output without duplicate deltas', () => {
  const active = { id: 'one', turnId: 'turn', items: new Map() },
    events: any[] = [];
  const notify = (method: string, params: unknown) => events.push({ method, params });
  const emit = (event: unknown) => h.translatePiEvent('one', event, active, notify);
  emit({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } });
  emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Checking' },
  });
  emit({
    type: 'message_end',
    message: { role: 'assistant', timestamp: 1, content: [{ type: 'text', text: 'Checking' }] },
  });
  emit({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'cmd',
    args: { command: 'pwd' },
  });
  emit({
    type: 'tool_execution_update',
    toolCallId: 'cmd',
    partialResult: { content: [{ type: 'text', text: 'hello' }] },
  });
  emit({
    type: 'tool_execution_update',
    toolCallId: 'cmd',
    partialResult: { content: [{ type: 'text', text: 'hello world' }] },
  });
  emit({
    type: 'tool_execution_end',
    toolName: 'bash',
    toolCallId: 'cmd',
    result: { content: [{ type: 'text', text: 'hello world' }] },
    isError: false,
  });
  emit({ type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } });
  emit({
    type: 'message_end',
    message: { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'Done' }] },
  });
  expect([...active.items.keys()]).toEqual(['assistant-1', 'cmd', 'assistant-2']);
  expect(events.filter((e) => e.method.endsWith('outputDelta')).map((e) => e.params.delta)).toEqual(
    ['hello', ' world'],
  );
  expect(active.items.get('cmd')).toMatchObject({
    command: 'pwd',
    status: 'completed',
    aggregatedOutput: 'hello world',
  });
  h.translatePiEvent(
    'other',
    { type: 'message_start', message: { role: 'user', timestamp: 4, content: 'private' } },
    active,
    notify,
  );
  expect([...active.items.keys()]).toHaveLength(3);
});

it('turns completed Pi edits with details diffs into file changes and safely falls back on errors', () => {
  expect(
    h.toolItem(
      'edit',
      'edit-1',
      { path: 'src/app.ts' },
      { content: [{ type: 'text', text: 'updated' }], details: { diff: '@@ -1 +1 @@' } },
    ),
  ).toMatchObject({
    type: 'fileChange',
    status: 'completed',
    changes: [{ path: 'src/app.ts', diff: '@@ -1 +1 @@' }],
  });
  expect(
    h.toolItem(
      'edit',
      'edit-2',
      { path: 'src/app.ts' },
      { content: [{ type: 'text', text: 'failed' }], details: { diff: '@@ diff' }, isError: true },
    ),
  ).toMatchObject({ type: 'dynamicToolCall', status: 'failed' });
  expect(h.toolItem('edit', 'edit-3', { path: 'src/app.ts' }, null, true)).toMatchObject({
    type: 'dynamicToolCall',
    status: 'inProgress',
  });
});
it('imports recursive Codex histories once, merges tools, retains archives and preserves originals', async () => {
  const source = path.join(root, 'codex', 'archived_sessions', '2026', '10');
  await mkdir(source, { recursive: true });
  const original =
    [
      {
        type: 'session_meta',
        timestamp: '2026-10-01T12:00:00Z',
        payload: { id: 'old', name: 'Imported thread', model: 'gpt-5' },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-01T12:00:01Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Fix this' }],
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-01T12:00:02Z',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'tool',
          arguments: '{"cmd":"pwd"}',
        },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-01T12:00:03Z',
        payload: { type: 'function_call_output', call_id: 'tool', output: '/workspace' },
      },
      {
        type: 'response_item',
        timestamp: '2026-10-01T12:00:04Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Done' }],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';
  const originalFile = path.join(source, 'history.jsonl');
  await writeFile(originalFile, original);
  const sessions = path.join(root, 'sessions'),
    index = path.join(root, 'index.json');
  expect(await h.importHistory(path.join(root, 'codex'), sessions, index)).toMatchObject({
    imported: 1,
    skipped: 0,
    errors: [],
  });
  const entry = h.readIndex(index).sessions[0];
  expect(entry).toMatchObject({
    displayName: 'Imported thread',
    archived: true,
    preview: 'Fix this',
  });
  const { SessionManager } = await h.sdk();
  const manager = SessionManager.open(entry.sessionFile, sessions);
  expect(h.transcript(manager)[0].items.map((i: any) => i.type)).toEqual([
    'userMessage',
    'commandExecution',
    'agentMessage',
  ]);
  expect(h.transcript(manager)[0].items[1]).toMatchObject({
    command: 'pwd',
    aggregatedOutput: '/workspace',
  });
  expect(await h.importHistory(path.join(root, 'codex'), sessions, index)).toMatchObject({
    imported: 0,
    skipped: 1,
    errors: [],
  });
  expect(await readFile(originalFile, 'utf8')).toBe(original);
  const fork = SessionManager.forkFrom(entry.sessionFile, '/workspace', sessions);
  expect(fork.getSessionId()).not.toBe(entry.threadId);
  expect(h.transcript(fork)).toEqual(h.transcript(manager));
  fork.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'Continue' }],
    timestamp: Date.now(),
  });
  expect(h.transcript(manager)).toHaveLength(1);
  expect(h.transcript(fork)).toHaveLength(2);
});
it('skips malformed histories without creating an index entry', async () => {
  await writeFile(path.join(root, 'bad.jsonl'), 'invalid');
  const index = path.join(root, 'index.json');
  expect(await h.importHistory(root, path.join(root, 'sessions'), index)).toMatchObject({
    imported: 0,
    skipped: 1,
  });
  expect(h.readIndex(index).sessions).toEqual([]);
});

it('retains repeated messages sharing a timestamp and marks unfinished persisted turns interrupted', async () => {
  const { SessionManager } = await h.sdk();
  const manager = SessionManager.create('/workspace', root);
  manager.appendCustomEntry('repellet.turn', { id: 'unfinished' });
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'First' }], timestamp: 1 });
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'Second' }],
    timestamp: 1,
  });
  const turns = h.transcript(manager);
  expect(turns[0].status).toBe('interrupted');
  expect(turns[0].items.map((item: any) => item.id)).toEqual(['user-1', 'user-1-1']);
});

it('preserves titles and archive state from the legacy private SQLite index', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const source = path.join(root, 'codex');
  await mkdir(source);
  const db = new DatabaseSync(path.join(source, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, title TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES (?,?,?)').run('old', 'Renamed in Codex', 1);
  db.close();
  await writeFile(
    path.join(source, 'old.jsonl'),
    [
      { type: 'session_meta', payload: { id: 'old' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Earlier message' }],
        },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n'),
  );
  const index = path.join(root, 'index.json');
  await h.importHistory(source, path.join(root, 'sessions'), index);
  expect(h.readIndex(index).sessions[0]).toMatchObject({
    displayName: 'Renamed in Codex',
    archived: true,
  });
});

it('stores the import identity in canonical history so restart recovery cannot import twice', async () => {
  await writeFile(
    path.join(root, 'old.jsonl'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Original' } }),
  );
  const sessions = path.join(root, 'sessions'),
    index = path.join(root, 'index.json');
  await h.importHistory(root, sessions, index);
  const entry = h.readIndex(index).sessions[0],
    { SessionManager } = await h.sdk();
  const manager = SessionManager.open(entry.sessionFile, sessions);
  expect(
    manager.getBranch().find((entry: any) => entry.customType === 'repellet.import').data.importId,
  ).toBe(entry.importId);
});

it('redacts credentials from payload content while preserving protocol keys and short-key model IDs', async () => {
  const { redactAgentPayload } = await import('@repellet/shared');
  const payload = {
    method: 'item/agentMessage/delta',
    params: { threadId: 'abc', itemId: 'abc', delta: 'a private key a', model: 'abc' },
  };
  const expected = {
    method: 'item/agentMessage/delta',
    params: {
      threadId: 'abc',
      itemId: 'abc',
      delta: '[redacted] priv[redacted]te key [redacted]',
      model: 'abc',
    },
  };
  expect(h.redactPayload(payload, ['a'])).toEqual(expected);
  expect(redactAgentPayload(payload, ['a'])).toEqual(expected);
});

it('withholds credential fragments across streamed message and cumulative tool deltas', () => {
  const active = { id: 'thread', turnId: 'turn', items: new Map() },
    events: any[] = [];
  const redact = (value: string, final = true) =>
    h.redactStreaming(value, ['aba-secret-aba'], final);
  const emit = (event: unknown) =>
    h.translatePiEvent(
      'thread',
      event,
      active,
      (method: string, params: unknown) => events.push({ method, params }),
      redact,
    );
  emit({ type: 'message_start', message: { role: 'assistant', timestamp: 1, content: [] } });
  for (const delta of ['prefix aba-', 'secret-', 'aba suffix'])
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
  const output = events
    .filter((e) => e.method === 'item/agentMessage/delta')
    .map((e) => e.params.delta)
    .join('');
  expect(output).toBe('prefix [redacted] suffix');
  emit({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'tool',
    args: { command: 'pwd' },
  });
  for (const text of ['prefix aba-', 'prefix aba-secret-aba suffix'])
    emit({
      type: 'tool_execution_update',
      toolCallId: 'tool',
      partialResult: { content: [{ type: 'text', text }] },
    });
  expect(
    events
      .filter((e) => e.method.endsWith('outputDelta'))
      .map((e) => e.params.delta)
      .join(''),
  ).toBe('prefix [redacted] suffix');
});
