const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const sdk = () => {
  const roots = [
    '/opt/pi/node_modules',
    path.join(__dirname, '../node_modules'),
    path.join(process.cwd(), 'node_modules'),
  ];
  const entry = roots
    .map((r) => path.join(r, '@earendil-works/pi-coding-agent/dist/index.js'))
    .find((p) => fs.existsSync(p));
  if (!entry) throw new Error('Pi SDK is not installed');
  return Promise.all([
    import(pathToFileURL(entry).href),
    import(pathToFileURL(path.join(path.dirname(entry), '../../pi-ai/dist/compat.js')).href),
  ]).then(([sdk, compat]) => ({
    ...sdk,
    getSupportedThinkingLevels: compat.getSupportedThinkingLevels,
  }));
};
const text = (content) =>
  typeof content === 'string'
    ? content
    : (content || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text || '')
        .join('');
const messageId = (message) => `${message.role}-${message.timestamp}`;
function planMode(manager) {
  let enabled = false;
  for (const entry of manager.getBranch())
    if (entry.type === 'custom' && entry.customType === 'plan-mode-state')
      enabled = entry.data?.enabled === true;
  return enabled;
}
const protocolFields = new Set([
  'role',
  'api',
  'stopReason',
  'toolName',
  'name',
  'cwd',
  'effort',
  'thinkingLevel',
  'source',
  'method',
  'type',
  'id',
  'threadId',
  'turnId',
  'itemId',
  'generation',
  'status',
  'provider',
  'model',
  'modelProvider',
  'reasoningEffort',
  'defaultReasoningEffort',
  'previousAccountId',
  'chatgptAccountId',
]);
function redactPayload(value, secrets, field = '') {
  if (typeof value === 'string') {
    if (protocolFields.has(field)) return value;
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, '[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactPayload(entry, secrets, field));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactPayload(entry, secrets, key)]),
    );
  return value;
}
function redactStreaming(value, secrets, final = true) {
  let safe = String(value);
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, '[redacted]');
  if (!final) {
    let hold = 0;
    for (const secret of secrets)
      if (secret)
        for (let length = 1; length < secret.length; length++)
          if (safe.endsWith(secret.slice(0, length))) hold = Math.max(hold, length);
    if (hold) safe = safe.slice(0, -hold);
  }
  return safe;
}
function toolItem(name, id, args, result, running = false) {
  const status = running ? 'inProgress' : result?.isError ? 'failed' : 'completed';
  if (['plan', 'plan_read', 'plan_edit', 'todo_edit'].includes(name) && !result?.isError)
    return { type: 'plan', id, text: text(result?.content) || args?.plan || '' };
  if (name === 'edit' && !running && !result?.isError && typeof result?.details?.diff === 'string')
    return {
      type: 'fileChange',
      id,
      status,
      changes: [
        {
          path: args?.path || args?.file || args?.filePath || '',
          kind: { type: 'update', move_path: null },
          diff: result.details.diff,
        },
      ],
    };
  if (name === 'bash')
    return {
      type: 'commandExecution',
      id,
      command: args?.command || '',
      cwd: '/workspace',
      status,
      aggregatedOutput: text(result?.content) || null,
      exitCode: running ? null : result?.isError ? 1 : 0,
      durationMs: null,
      commandActions: [],
      processId: null,
      source: 'agent',
      pluginId: null,
      scriptPath: null,
    };
  return {
    type: 'dynamicToolCall',
    id,
    tool: name,
    namespace: null,
    arguments: args || {},
    status,
    contentItems: (result?.content || []).map((p) =>
      p.type === 'text'
        ? { type: 'inputText', text: p.text }
        : { type: 'inputImage', imageUrl: '' },
    ),
    success: running ? null : !result?.isError,
    durationMs: null,
  };
}
function messageItems(message, tools = new Map(), idOverride) {
  const id = idOverride || messageId(message);
  if (message.role === 'user')
    return [
      {
        type: 'userMessage',
        id,
        clientId: null,
        content: [{ type: 'text', text: text(message.content) }],
      },
    ];
  if (message.role === 'assistant') {
    const items = [];
    if (text(message.content))
      items.push({
        type: 'agentMessage',
        id,
        text: text(message.content),
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      });
    for (const part of message.content || [])
      if (part.type === 'toolCall') {
        tools.set(part.id, { name: part.name, args: part.arguments });
        items.push(toolItem(part.name, part.id, part.arguments, null, true));
      }
    return items;
  }
  if (message.role === 'toolResult') {
    const tool = tools.get(message.toolCallId);
    return [toolItem(message.toolName || tool?.name, message.toolCallId, tool?.args, message)];
  }
  return [];
}
function nextMessageId(message, counts) {
  const key = messageId(message),
    count = counts.get(key) || 0;
  counts.set(key, count + 1);
  return count ? `${key}-${count}` : key;
}
function messageCounts(manager) {
  const counts = new Map();
  for (const entry of manager.getBranch())
    if (entry.type === 'message') nextMessageId(entry.message, counts);
  return counts;
}
function transcript(manager, activeTurnId) {
  const turns = [],
    tools = new Map(),
    counts = new Map();
  let turn,
    explicit = false;
  const branch = manager.getBranch();
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === 'repellet.turn') {
      explicit = true;
      turn = {
        id: entry.data.id,
        items: [],
        itemsView: 'full',
        status: 'interrupted',
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      turns.push(turn);
    }
    if (entry.type === 'custom' && entry.customType === 'repellet.turn.result' && turn) {
      turn.status = entry.data.status;
      turn.error = entry.data.error || null;
    }
    if (entry.type !== 'message') continue;
    if (!turn || (entry.message.role === 'user' && turn.items.length && !explicit)) {
      turn = {
        id: entry.id,
        items: [],
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      turns.push(turn);
    }
    for (const item of messageItems(entry.message, tools, nextMessageId(entry.message, counts))) {
      const at = turn.items.findIndex((i) => i.id === item.id);
      if (at < 0) turn.items.push(item);
      else turn.items[at] = item;
    }
    if (
      entry.message.role === 'assistant' &&
      ['error', 'aborted'].includes(entry.message.stopReason)
    ) {
      turn.status = entry.message.stopReason === 'aborted' ? 'interrupted' : 'failed';
      turn.error = entry.message.errorMessage ? { message: entry.message.errorMessage } : null;
    }
  }
  if (activeTurnId) for (const t of turns) if (t.id === activeTurnId) t.status = 'inProgress';
  return turns.filter((t) => t.items.length);
}
function readIndex(indexFile) {
  try {
    const value = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.sessions)) throw Error();
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, sessions: [] };
    throw new Error('Agent session index is unreadable');
  }
}
function writeIndex(indexFile, index) {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true, mode: 0o700 });
  const temp = `${indexFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(index), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, indexFile);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function codexMetadata(sourceDir) {
  const metadata = new Map();
  if (!fs.existsSync(sourceDir)) return metadata;
  const databases = fs
    .readdirSync(sourceDir)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  for (const file of databases) {
    let db;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(path.join(sourceDir, file), { readOnly: true });
      const columns = db
        .prepare('PRAGMA table_info(threads)')
        .all()
        .map((column) => column.name);
      const fields = [
        'id',
        'title',
        'archived',
        'created_at',
        'updated_at',
        'model_provider',
      ].filter((field) => columns.includes(field));
      if (!fields.includes('id')) continue;
      for (const row of db.prepare(`SELECT ${fields.join(',')} FROM threads`).all())
        if (!metadata.has(row.id)) metadata.set(row.id, row);
    } catch {
      /* Transcript import still works when optional legacy metadata is unavailable. */
    } finally {
      db?.close();
    }
  }
  return metadata;
}
async function importHistory(sourceDir, sessionDir, indexFile) {
  const { SessionManager } = await sdk();
  const metadata = codexMetadata(sourceDir);
  const index = readIndex(indexFile),
    result = {
      imported: 0,
      skipped: 0,
      errors: [],
      importedConversations: [],
      skippedConversations: [],
    };
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  function visit(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? visit(path.join(dir, e.name))
          : e.isFile() && e.name.endsWith('.jsonl')
            ? [path.join(dir, e.name)]
            : [],
      );
  }
  for (const file of visit(sourceDir)) {
    const importId = createHash('sha256').update(path.resolve(file)).digest('hex');
    const existing = index.sessions.find((s) => s.importId === importId);
    if (existing) {
      result.skipped++;
      result.skippedConversations.push(
        existing.displayName || existing.preview || 'Untitled conversation',
      );
      continue;
    }
    let target;
    try {
      const records = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const manager = SessionManager.create('/workspace', sessionDir);
      target = manager.getSessionFile();
      let name = null,
        model = '',
        preview = '',
        messages = 0;
      const zeroUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const hasResponseItems = records.some((r) => r.type === 'response_item');
      for (const record of records) {
        const p = record.payload || record,
          kind = p.type;
        if (record.type === 'session_meta') {
          name = p.name || p.thread_name || name;
          model = p.model || model;
        }
        if (record.type === 'turn_context') model = p.model || model;
        if (['thread_name', 'session_info', 'thread_name_updated'].includes(kind))
          name = p.name || p.text || p.message || name;
        let message;
        const timestamp = Date.parse(record.timestamp || '') || Date.now();
        if (
          (record.type === 'response_item' || !record.payload) &&
          kind === 'message' &&
          ['user', 'assistant'].includes(p.role)
        ) {
          const content = (p.content || [])
            .filter((c) => ['input_text', 'output_text', 'text'].includes(c.type))
            .map((c) => ({ type: 'text', text: c.text }));
          if (!content.length) continue;
          message =
            p.role === 'user'
              ? { role: 'user', content, timestamp }
              : {
                  role: 'assistant',
                  content,
                  timestamp,
                  api: 'openai-responses',
                  provider: 'openai-codex',
                  model,
                  usage: zeroUsage,
                  stopReason: 'stop',
                };
        } else if (!hasResponseItems && ['user_message', 'agent_message'].includes(kind)) {
          const role = kind === 'user_message' ? 'user' : 'assistant';
          message = {
            role,
            content: [{ type: 'text', text: p.message || p.text || '' }],
            timestamp,
            ...(role === 'assistant'
              ? {
                  api: 'openai-responses',
                  provider: 'openai-codex',
                  model,
                  usage: zeroUsage,
                  stopReason: 'stop',
                }
              : {}),
          };
        } else if (['function_call', 'custom_tool_call'].includes(kind)) {
          let args;
          try {
            args = JSON.parse(p.arguments || '{}');
          } catch {
            args = { input: p.input || p.arguments };
          }
          if (p.input) args = { input: p.input };
          const toolName = ['exec_command', 'shell'].includes(p.name) ? 'bash' : p.name;
          if (toolName === 'bash')
            args = {
              command:
                args.cmd ||
                (Array.isArray(args.command) ? args.command.join(' ') : args.command) ||
                '',
            };
          message = {
            role: 'assistant',
            content: [{ type: 'toolCall', id: p.call_id || p.id, name: toolName, arguments: args }],
            timestamp,
            api: 'openai-responses',
            provider: 'openai-codex',
            model,
            usage: zeroUsage,
            stopReason: 'toolUse',
          };
        } else if (['function_call_output', 'custom_tool_call_output'].includes(kind)) {
          const previous = manager
            .getEntries()
            .flatMap((e) =>
              e.type === 'message' && e.message.role === 'assistant' ? e.message.content : [],
            )
            .find((c) => c.type === 'toolCall' && c.id === p.call_id);
          message = {
            role: 'toolResult',
            toolCallId: p.call_id,
            toolName: previous?.name || 'legacy',
            content: [
              {
                type: 'text',
                text: typeof p.output === 'string' ? p.output : JSON.stringify(p.output),
              },
            ],
            timestamp,
            isError: false,
          };
        }
        if (message) {
          manager.appendMessage(message);
          messages++;
          if (!preview && message.role === 'user') preview = text(message.content).slice(0, 500);
        }
      }
      if (!messages) {
        result.skipped++;
        result.skippedConversations.push(name || path.basename(file));
        continue;
      }
      const originalId = records.find((record) => record.type === 'session_meta')?.payload?.id;
      const meta = metadata.get(originalId);
      name = meta?.title || name;
      if (name) manager.appendSessionInfo(name);
      const stamp = records[0]?.timestamp || new Date().toISOString();
      index.sessions.push({
        threadId: manager.getSessionId(),
        displayName: name,
        archived:
          !!meta?.archived ||
          file.includes('/archived_sessions/') ||
          records.some((record) => record.payload?.archived === true),
        createdAt: stamp,
        updatedAt: records.at(-1)?.timestamp || stamp,
        sessionFile: target,
        provider: meta?.model_provider || 'openai-codex',
        model,
        preview,
        importId,
      });
      manager.appendCustomEntry('repellet.import', {
        importId,
        displayName: name,
        archived: !!meta?.archived || file.includes('/archived_sessions/'),
        provider: meta?.model_provider || 'openai-codex',
        model,
        preview,
      });
      writeIndex(indexFile, index);
      result.imported++;
      result.importedConversations.push(name || preview || 'Untitled conversation');
    } catch {
      if (target) {
        fs.rmSync(target, { force: true });
        index.sessions = index.sessions.filter((e) => e.sessionFile !== target);
      }
      result.skipped++;
      result.skippedConversations.push(path.basename(file));
      result.errors.push(`${path.basename(file)}: history could not be imported`);
    }
  }
  return result;
}
function translatePiEvent(id, event, active, notify, redact = (value) => value) {
  const a = active;
  if (!a || a.id !== id) return;
  const params = { threadId: id, turnId: a.turnId };
  if (event.type === 'message_start' && ['user', 'assistant'].includes(event.message.role)) {
    a.counts ||= new Map();
    const id = nextMessageId(event.message, a.counts);
    if (event.message.role === 'assistant') a.messageId = id;
    else a.userMessageId = id;
    for (const item of messageItems(event.message, new Map(), id))
      if (item.type !== 'dynamicToolCall' && item.type !== 'commandExecution') {
        a.items.set(item.id, item);
        notify('item/started', { ...params, item });
      }
  }
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    if (!a.items.has(a.messageId)) {
      const item = {
        type: 'agentMessage',
        id: a.messageId,
        text: '',
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      a.items.set(item.id, item);
      notify('item/started', { ...params, item });
    }
    a.rawTexts ||= new Map();
    const raw = (a.rawTexts.get(a.messageId) || '') + event.assistantMessageEvent.delta;
    a.rawTexts.set(a.messageId, raw);
    const item = a.items.get(a.messageId),
      safe = redact(raw, false);
    const delta = safe.slice(item.text.length);
    item.text = safe;
    if (delta) notify('item/agentMessage/delta', { ...params, itemId: a.messageId, delta });
  }
  if (event.type === 'message_end' && ['user', 'assistant'].includes(event.message.role)) {
    for (const item of messageItems(
      event.message,
      new Map(),
      event.message.role === 'assistant' ? a.messageId : a.userMessageId,
    ))
      if (item.type !== 'dynamicToolCall' && item.type !== 'commandExecution') {
        a.items.set(item.id, item);
        notify('item/completed', { ...params, item });
      }
    if (event.message.stopReason === 'error')
      a.error = redact(event.message.errorMessage || 'Provider request failed');
    if (event.message.stopReason === 'aborted') a.aborted = true;
  }
  if (event.type === 'tool_execution_start') {
    const item = toolItem(event.toolName, event.toolCallId, event.args, null, true);
    a.items.set(item.id, item);
    notify('item/started', { ...params, item });
  }
  if (event.type === 'tool_execution_update') {
    const item = a.items.get(event.toolCallId);
    if (item?.type === 'commandExecution') {
      const output = redact(text(event.partialResult?.content), false);
      const old = item.aggregatedOutput || '';
      item.aggregatedOutput = output;
      notify('item/commandExecution/outputDelta', {
        ...params,
        itemId: item.id,
        delta: output.startsWith(old) ? output.slice(old.length) : output,
      });
    }
  }
  if (event.type === 'tool_execution_end') {
    const previous = a.items.get(event.toolCallId),
      item = toolItem(
        event.toolName || previous?.tool || (previous?.type === 'commandExecution' ? 'bash' : ''),
        event.toolCallId,
        previous?.arguments || (previous ? { command: previous.command } : {}),
        { ...event.result, isError: event.isError },
      );
    a.items.set(item.id, item);
    notify('item/completed', { ...params, item });
  }
}
module.exports = {
  planMode,
  redactStreaming,
  redactPayload,
  nextMessageId,
  messageCounts,
  translatePiEvent,
  sdk,
  text,
  messageId,
  messageItems,
  toolItem,
  transcript,
  readIndex,
  writeIndex,
  importHistory,
};
