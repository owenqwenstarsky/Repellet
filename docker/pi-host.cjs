// Private, provider-neutral JSONL service. Pi owns canonical session history.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./pi-session.cjs');
process.umask(0o077);
const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/agent/.pi/agent';
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR || '/home/agent/.pi/sessions';
const provider = process.env.REPELLET_PI_PROVIDER || 'openai-codex';
const modelId = process.env.REPELLET_PI_MODEL || '';
const normalizeEffort = (value) => (value === 'none' ? 'off' : value === 'ultra' ? 'max' : value);
const configuredEffort = process.env.REPELLET_PI_EFFORT || 'medium';
const effort = normalizeEffort(configuredEffort);
const key = process.env.REPELLET_AGENT_API_KEY;
const baseUrl = process.env.REPELLET_PI_BASE_URL;
const proxyModels = process.env.REPELLET_PI_MODELS
  ? JSON.parse(process.env.REPELLET_PI_MODELS)
  : modelId
    ? [modelId]
    : [];
const defaults = process.env.REPELLET_PI_DEFAULTS
  ? JSON.parse(process.env.REPELLET_PI_DEFAULTS)
  : {};
const providerForApi = (api) => (api === 'cliproxyapi' ? 'repellet' : 'openai-codex');
const apiForProvider = (p) => (p === 'repellet' ? 'cliproxyapi' : 'chatgpt');
const defaultFor = (p) =>
  defaults[apiForProvider(p)] || {
    model: p === provider ? modelId : '',
    effort: p === provider ? configuredEffort : 'medium',
  };
let access = process.env.REPELLET_CHATGPT_ACCESS_TOKEN;
let accountId = process.env.REPELLET_CHATGPT_ACCOUNT_ID;
const secrets = [key, access].filter(Boolean);
for (const k of Object.keys(process.env))
  if (/^(REPELLET_|BRIDGE_TOKEN$|WORKER_TOKEN$|STORAGE_LIMIT_MB$)/.test(k)) delete process.env[k];
const indexFile = path.join(agentDir, 'repellet-sessions.json');
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
const emit = (value) =>
  process.stdout.write(JSON.stringify(h.redactPayload(value, secrets)) + '\n');
const notify = (method, params) => emit({ method, params });
const redact = (value, final = true) => h.redactStreaming(value, secrets, final);
let runtime,
  api,
  active = null;
const sessions = new Map(),
  pending = new Map();
const request = h.createRequest(pending, emit, notify);
function expiry(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000;
  } catch {
    return 0;
  }
}
let refresh;
async function credential() {
  if (!access) return undefined;
  if (expiry(access) < Date.now() + 600000) {
    if (!refresh)
      refresh = request('account/chatgptAuthTokens/refresh', { previousAccountId: accountId })
        .then((t) => {
          access = t.accessToken;
          accountId = t.chatgptAccountId;
          secrets.push(access);
        })
        .finally(() => {
          refresh = null;
        });
    await refresh;
  }
  return { type: 'oauth', access, accountId, refresh: '', expires: expiry(access) };
}
const credentials = {
  read: async (p) => (p === 'openai-codex' ? credential() : undefined),
  list: async () => (access ? [{ providerId: 'openai-codex', type: 'oauth' }] : []),
  // Refresh happens centrally: project volumes never contain refresh tokens.
  modify: async (p) => (p === 'openai-codex' ? credential() : undefined),
  delete: async () => {},
};
function entry(id) {
  const e = h.readIndex(indexFile).sessions.find((s) => s.threadId === id);
  if (!e) throw new Error('Unknown thread');
  return e;
}
function manager(id) {
  const e = entry(id),
    file = fs.realpathSync(e.sessionFile),
    root = fs.realpathSync(sessionDir);
  if (!file.startsWith(root + path.sep)) throw new Error('Invalid session');
  const m = api.SessionManager.open(file, sessionDir, '/workspace');
  if (m.getSessionId() !== id || m.getHeader().cwd !== '/workspace')
    throw new Error('Invalid session');
  return m;
}
function update(id, values) {
  const idx = h.readIndex(indexFile),
    e = idx.sessions.find((s) => s.threadId === id);
  if (!e) throw new Error('Unknown thread');
  Object.assign(e, values);
  h.writeIndex(indexFile, idx);
  return e;
}
function persistEmpty(m) {
  // Pi intentionally leaves empty sessions in memory. Persist their valid header and
  // reopen through its public API so Repellet's explicit New thread survives restart.
  if (!fs.existsSync(m.getSessionFile()))
    fs.writeFileSync(m.getSessionFile(), JSON.stringify(m.getHeader()) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  return api.SessionManager.open(m.getSessionFile(), sessionDir, '/workspace');
}
function add(
  m,
  from = null,
  selectedModel = modelId,
  selectedProvider = from?.provider || provider,
  selectedEffort = from?.reasoningEffort || defaultFor(selectedProvider).effort,
) {
  const stamp = new Date().toISOString(),
    idx = h.readIndex(indexFile);
  const e = {
    threadId: m.getSessionId(),
    displayName: m.getSessionName() || null,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
    sessionFile: m.getSessionFile(),
    provider: selectedProvider,
    reasoningEffort: selectedEffort || null,
    model: selectedModel || from?.model || modelId,
    preview: from?.preview || '',
    forkedFromId: from?.threadId || null,
    planMode: h.planMode(m),
  };
  idx.sessions.push(e);
  h.writeIndex(indexFile, idx);
  return e;
}
function thread(e, turns = []) {
  return {
    id: e.threadId,
    name: e.displayName,
    preview: e.preview,
    createdAt: Date.parse(e.createdAt) / 1000,
    updatedAt: Date.parse(e.updatedAt) / 1000,
    recencyAt: Date.parse(e.updatedAt) / 1000,
    modelProvider: e.provider,
    model: e.model,
    api: apiForProvider(e.provider),
    reasoningEffort: e.reasoningEffort || null,
    planMode: e.planMode === true,
    path: null,
    cwd: '/workspace',
    parentThreadId: null,
    forkedFromId: e.forkedFromId || null,
    turns,
    status: active?.id === e.threadId ? 'active' : 'idle',
    source: 'appServer',
    ephemeral: false,
    canAcceptDirectInput: true,
  };
}
async function load(id, selection = {}) {
  if (!sessions.has(id)) {
    const m = manager(id),
      settings = api.SettingsManager.inMemory({ retry: { enabled: false } });
    const eventBus = api.createEventBus();
    eventBus.on(
      'repellet:project-control',
      ({ operation, arguments: args, signal, resolve, reject }) => {
        if (active?.id !== id || active.controller.signal.aborted)
          return reject(new Error('No active turn for this project request'));
        const cancel = signal
          ? AbortSignal.any([signal, active.controller.signal])
          : active.controller.signal;
        void request(
          'repellet/project/control',
          {
            operation,
            arguments: args,
            threadId: id,
            turnId: active.turnId,
          },
          cancel,
        ).then(resolve, reject);
      },
    );
    eventBus.on('repellet:question', ({ questions, signal, itemId, resolve, reject }) => {
      if (active?.id !== id) return reject(new Error('No active turn for this question'));
      const cancel = signal
        ? AbortSignal.any([signal, active.controller.signal])
        : active.controller.signal;
      void request(
        'item/tool/requestUserInput',
        {
          threadId: id,
          turnId: active.turnId,
          itemId: itemId || crypto.randomUUID(),
          questions,
          isBlocking: true,
        },
        cancel,
      ).then(resolve, reject);
    });
    const extensionsDir = fs.existsSync('/opt/pi/extensions')
      ? '/opt/pi/extensions'
      : path.join(__dirname, 'pi-extensions');
    const loader = new api.DefaultResourceLoader({
      cwd: '/workspace',
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      eventBus,
      additionalExtensionPaths: ['websearch.ts', 'project.ts', 'plan.ts'].map((name) =>
        path.join(extensionsDir, name),
      ),
      disabledBuiltinExtensions: ['mcp'],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: fs.existsSync(path.join(agentDir, 'SYSTEM.md'))
        ? fs.readFileSync(path.join(agentDir, 'SYSTEM.md'), 'utf8')
        : undefined,
    });
    await loader.reload();
    if (loader.getExtensions().errors.length)
      throw new Error('Bundled Pi extensions failed to load');
    const selectedProvider = selection.api
      ? providerForApi(selection.api)
      : entry(id).provider || provider;
    const available = runtime.getModels
      ? runtime.getModels(selectedProvider)
      : await runtime.getAvailable(selectedProvider);
    let model =
      runtime.getModel(selectedProvider, selection.model || entry(id).model) ||
      h.defaultModel(available, defaultFor(selectedProvider).model);
    if (!model) throw new Error('Configure your provider in Agent settings');
    if (selectedProvider === 'repellet' && entry(id).reasoningEffort === 'ultra')
      model = { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, max: 'ultra' } };
    const { session } = await api.createAgentSession({
      cwd: '/workspace',
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: normalizeEffort(
        selection.effort ||
          entry(id).reasoningEffort ||
          defaultFor(selectedProvider).effort ||
          'medium',
      ),
      sessionManager: m,
      settingsManager: settings,
      resourceLoader: loader,
      tools: ['+question'],
      customTools: [
        {
          name: 'question',
          label: 'Ask owner',
          description:
            'Ask the owner a blocking question when a decision or missing information is required.',
          parameters: {
            type: 'object',
            properties: {
              questions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    header: { type: 'string' },
                    question: { type: 'string' },
                    options: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { label: { type: 'string' }, description: { type: 'string' } },
                        required: ['label', 'description'],
                      },
                    },
                  },
                  required: ['id', 'header', 'question'],
                },
              },
            },
            required: ['questions'],
          },
          execute: async (toolCallId, args, signal) => {
            const result = await request(
              'item/tool/requestUserInput',
              {
                threadId: id,
                turnId: active?.turnId,
                itemId: toolCallId,
                questions: args.questions,
                isBlocking: true,
              },
              signal,
            );
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
          },
        },
      ],
    });
    const appendMessage = m.appendMessage.bind(m);
    m.appendMessage = (message) => appendMessage(h.redactPayload(message, secrets));
    const appendCustomEntry = m.appendCustomEntry.bind(m);
    m.appendCustomEntry = (type, data) => {
      const result = appendCustomEntry(type, h.redactPayload(data, secrets));
      if (type === 'plan-mode-state') {
        update(id, { planMode: data.enabled === true });
        notify('thread/planMode/updated', { threadId: id, enabled: data.enabled === true });
      }
      return result;
    };
    session.subscribe((event) => {
      if (event.type === 'message_start' && active?.id === id)
        h.attachInputMetadata(event.message, active.inputQueue);
      h.translatePiEvent(id, event, active, notify, redact);
    });
    await session.bindExtensions({
      mode: 'rpc',
      onError: () =>
        notify('error', { error: { message: 'Pi extension failed. Retry or restart the agent.' } }),
    });
    sessions.set(id, session);
  }
  return sessions.get(id);
}
async function selectModel(s, params) {
  const selectedProvider = params.api ? providerForApi(params.api) : s.model.provider;
  const available = runtime.getModels
    ? runtime.getModels(selectedProvider)
    : await runtime.getAvailable(selectedProvider);
  const selected =
    params.model === ''
      ? h.defaultModel(available)?.id
      : params.model ||
        (s.model.provider === selectedProvider ? s.model.id : defaultFor(selectedProvider).model);
  const m = runtime.getModel(selectedProvider, selected);
  if (!m) throw new Error('Unknown or unavailable model');
  if (s.model.id !== m.id || s.model.provider !== m.provider) await s.setModel(m);
  const selectedEffort =
    params.effort === null
      ? s.model.reasoning
        ? 'medium'
        : 'none'
      : params.effort || defaultFor(selectedProvider).effort;
  if (selectedEffort) {
    if (selectedProvider === 'repellet' && ['max', 'ultra'].includes(selectedEffort))
      await s.setModel({
        ...s.model,
        thinkingLevelMap: { ...s.model.thinkingLevelMap, max: selectedEffort },
      });
    s.setThinkingLevel(normalizeEffort(selectedEffort));
  }
}
async function run(id, params) {
  if (active) throw new Error('Another turn is active');
  if (entry(id).archived) throw new Error('Unarchive this thread to continue');
  const s = await load(id, params);
  const prepared = h.prepareInput(params.input);
  await selectModel(s, params);
  const turnId = crypto.randomUUID(),
    a = {
      id,
      turnId,
      items: new Map(),
      counts: h.messageCounts(s.sessionManager),
      aborted: false,
      controller: new AbortController(),
      error: null,
      inputQueue: [{ text: prepared.text, input: params.input }],
    };
  active = a;
  s.sessionManager.appendCustomEntry('repellet.turn', { id: turnId });
  update(id, {
    updatedAt: new Date().toISOString(),
    provider: s.model.provider,
    model: s.model.id,
    reasoningEffort:
      params.effort !== undefined
        ? params.effort
        : entry(id).reasoningEffort || defaultFor(s.model.provider).effort || null,
    preview: redact(params.input.map((p) => p.text || '').join('\n')).slice(0, 500),
  });
  const turn = {
    id: turnId,
    status: 'inProgress',
    items: [],
    itemsView: 'streaming',
    error: null,
    startedAt: Date.now() / 1000,
    completedAt: null,
    durationMs: null,
  };
  notify('turn/started', { threadId: id, turn });
  void s
    .prompt(prepared.text, { images: prepared.images })
    .catch(() => {
      a.error = 'Agent request failed. Check your provider and retry.';
    })
    .finally(() => {
      const status = a.aborted ? 'interrupted' : a.error ? 'failed' : 'completed',
        error = a.error ? { message: a.error } : null;
      s.sessionManager.appendCustomEntry('repellet.turn.result', { status, error });
      update(id, { updatedAt: new Date().toISOString() });
      // Read persisted history to ensure live and resumed ordering are identical.
      const persisted = h.transcript(s.sessionManager).find((t) => t.id === turnId);
      notify('turn/completed', {
        threadId: id,
        turn: {
          ...turn,
          items:
            persisted?.items ||
            Array.from(a.items.values()).filter((i) => i.type !== 'agentMessage' || i.text),
          itemsView: 'full',
          status,
          error,
          completedAt: Date.now() / 1000,
        },
      });
      if (active === a) active = null;
    });
  return { turn };
}
async function handle({ method, params = {} }) {
  if (method === 'initialize' || method === 'initialized')
    return { protocol: 'repellet-agent', provider: 'pi', version: '1.1.0', apiSelection: true };
  if (method === 'account/login/start') {
    access = params.accessToken;
    accountId = params.chatgptAccountId;
    if (access && !secrets.includes(access)) secrets.push(access);
    return { ok: true };
  }
  if (method === 'thread/list') {
    const entries = h
      .readIndex(indexFile)
      .sessions.filter(
        (e) =>
          e.archived === !!params.archived &&
          (!params.search ||
            `${e.displayName || ''} ${e.preview}`
              .toLowerCase()
              .includes(params.search.toLowerCase())),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = params.cursor ? Number(params.cursor) : 0,
      limit = params.limit || 100;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid thread cursor');
    return {
      data: entries.slice(offset, offset + limit).map((e) => thread(e)),
      nextCursor: offset + limit < entries.length ? String(offset + limit) : null,
    };
  }
  if (method === 'thread/start') {
    const selectedProvider = params.api ? providerForApi(params.api) : provider;
    const available = runtime.getModels
      ? runtime.getModels(selectedProvider)
      : await runtime.getAvailable(selectedProvider);
    const selected =
      params.model || h.defaultModel(available, defaultFor(selectedProvider).model)?.id || '';
    const e = add(
      persistEmpty(api.SessionManager.create('/workspace', sessionDir)),
      null,
      selected.replace(selectedProvider + '/', ''),
      selectedProvider,
      params.effort !== undefined ? params.effort : defaultFor(selectedProvider).effort,
    );
    const t = thread(e);
    notify('thread/started', { thread: t });
    return { thread: t };
  }
  if (method === 'model/list') {
    const selectedProvider = params.api ? providerForApi(params.api) : provider;
    const available = runtime.getModels
      ? runtime.getModels(selectedProvider)
      : await runtime.getAvailable(selectedProvider);
    const selected = h.defaultModel(available, defaultFor(selectedProvider).model);
    const data = available.map((m) => ({
      id: selectedProvider + '/' + m.id,
      model: m.id,
      displayName: m.name,
      isDefault: m.id === selected?.id,
      supportedReasoningEfforts: [
        ...api.getSupportedThinkingLevels(m),
        ...(selectedProvider === 'repellet' ? ['ultra'] : []),
      ]
        .map((level) => (level === 'off' ? 'none' : level))
        .map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
      defaultReasoningEffort: m.reasoning ? 'medium' : null,
    }));
    return { data, nextCursor: null };
  }
  if (method === 'turn/steer') {
    if (!active || active.id !== params.threadId || active.turnId !== params.expectedTurnId)
      throw new Error('Active turn changed');
    const current = active;
    const prepared = h.prepareInput(params.input);
    const queued = { text: prepared.text, input: params.input };
    current.inputQueue.push(queued);
    try {
      await sessions.get(current.id).steer(prepared.text, prepared.images);
    } catch (error) {
      const at = current.inputQueue.indexOf(queued);
      if (at !== -1) current.inputQueue.splice(at, 1);
      throw error;
    }
    return { turnId: current.turnId };
  }
  if (method === 'turn/interrupt') {
    if (!active || active.id !== params.threadId || active.turnId !== params.turnId)
      throw new Error('This turn is no longer active');
    active.aborted = true;
    active.controller.abort();
    await sessions.get(active.id).abort();
    return { ok: true };
  }
  if (method === 'turn/start') return run(params.threadId, params);
  const e = entry(params.threadId);
  if (method === 'thread/resume' && (params.api || params.model !== undefined))
    update(e.threadId, {
      provider: params.api ? providerForApi(params.api) : e.provider,
      model: params.model !== undefined ? params.model : e.model,
      reasoningEffort: params.effort !== undefined ? params.effort : e.reasoningEffort || null,
    });
  if (method === 'thread/read' || method === 'thread/resume')
    return {
      thread: thread(
        e,
        params.includeTurns
          ? h.transcript(
              sessions.get(e.threadId)?.sessionManager || manager(e.threadId),
              active?.id === e.threadId ? active.turnId : null,
            )
          : [],
      ),
    };
  if (active?.id === e.threadId)
    throw new Error('Stop the active turn before changing this thread');
  if (method === 'thread/plan/toggle') {
    if (active) throw new Error('Stop the active turn before changing plan mode');
    if (e.archived) throw new Error('Unarchive this thread to change plan mode');
    const s = await load(e.threadId);
    await s.prompt('/plan');
    return { thread: thread(entry(e.threadId)) };
  }
  if (method === 'thread/name/set') {
    const m = sessions.get(e.threadId)?.sessionManager || manager(e.threadId);
    m.appendSessionInfo(params.name);
    const updated = update(e.threadId, {
      displayName: params.name,
      updatedAt: new Date().toISOString(),
    });
    notify('thread/name/updated', { threadId: e.threadId, name: params.name });
    return { thread: thread(updated) };
  }
  if (method === 'thread/archive' || method === 'thread/unarchive') {
    update(e.threadId, { archived: method === 'thread/archive' });
    notify(method === 'thread/archive' ? 'thread/archived' : 'thread/unarchived', {
      threadId: e.threadId,
    });
    return { ok: true };
  }
  if (method === 'thread/fork') {
    const m = api.SessionManager.forkFrom(e.sessionFile, '/workspace', sessionDir);
    const t = thread(add(m, e), h.transcript(m));
    notify('thread/started', { thread: t });
    return { thread: t };
  }
  if (method === 'thread/compact/start') {
    const s = await load(e.threadId, params);
    await selectModel(s, params);
    update(e.threadId, {
      provider: s.model.provider,
      model: s.model.id,
      reasoningEffort: params.effort !== undefined ? params.effort : e.reasoningEffort || null,
    });
    await s.compact();
    return { thread: thread(e, h.transcript(s.sessionManager)) };
  }
  throw new Error('Unsupported agent operation');
}
async function main() {
  api = await h.sdk();
  if (process.argv.includes('--import')) {
    emit(await h.importHistory('/home/agent/.codex', sessionDir, indexFile));
    return;
  }
  const index = h.readIndex(indexFile);
  const indexedFiles = new Set(index.sessions.map((entry) => path.resolve(entry.sessionFile)));
  for (const name of fs.readdirSync(sessionDir)) {
    const file = path.join(sessionDir, name);
    if (!name.endsWith('.jsonl') || indexedFiles.has(file)) continue;
    try {
      if (!fs.realpathSync(file).startsWith(fs.realpathSync(sessionDir) + path.sep)) continue;
      const m = api.SessionManager.open(file, sessionDir);
      if (
        m.getHeader()?.cwd !== '/workspace' ||
        index.sessions.some((e) => e.threadId === m.getSessionId())
      )
        continue;
      const stamp = m.getHeader().timestamp;
      const imported = m
        .getBranch()
        .find((entry) => entry.type === 'custom' && entry.customType === 'repellet.import')?.data;
      index.sessions.push({
        ...(imported || {}),
        threadId: m.getSessionId(),
        displayName: m.getSessionName() || null,
        archived: imported?.archived || false,
        createdAt: stamp,
        updatedAt: stamp,
        sessionFile: file,
        provider: imported?.provider || provider,
        model: imported?.model || modelId,
        planMode: h.planMode(m),
        preview: h
          .text(
            m.buildSessionContext().messages.find((message) => message.role === 'user')?.content,
          )
          .slice(0, 500),
      });
    } catch {
      /* Invalid files remain untouched for recovery. */
    }
  }
  h.writeIndex(indexFile, index);
  // Credentials and the proxy catalog stay in memory, outside project files.
  fs.rmSync(path.join(agentDir, 'auth.json'), { force: true });
  fs.rmSync(path.join(agentDir, 'models.json'), { force: true });
  runtime = await api.ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  if (key && baseUrl && proxyModels.length) {
    const known = runtime.getModels();
    runtime.registerProvider('repellet', {
      baseUrl,
      api: 'openai-responses',
      models: proxyModels.map((id) => {
        const metadata = known.find((model) => model.id === id);
        return {
          id,
          name: id,
          reasoning: metadata?.reasoning ?? true,
          thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
          input: metadata?.input || ['text'],
          cost: metadata?.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: metadata?.contextWindow || 200000,
          maxTokens: metadata?.maxTokens || 16384,
        };
      }),
    });
    await runtime.setRuntimeApiKey('repellet', key);
  }
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      if (!req.method) {
        const p = pending.get(req.id);
        if (p) {
          pending.delete(req.id);
          req.error ? p.reject(new Error('Account request failed')) : p.resolve(req.result);
        }
        continue;
      }
      void handle(req)
        .then((result) => {
          if (req.id !== undefined) emit({ id: req.id, result });
        })
        .catch((error) => {
          if (req.id !== undefined)
            emit({
              id: req.id,
              error: {
                code: -32000,
                message:
                  error.message.includes(agentDir) || error.message.includes(sessionDir)
                    ? 'Saved conversation is unavailable. Check Agent settings and retry.'
                    : redact(error.message),
              },
            });
        });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
main().catch(() => {
  process.stderr.write('Pi host could not initialize. Check Agent settings.\n');
  process.exitCode = 1;
});
