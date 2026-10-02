#!/usr/bin/env node
// Deterministic app-server fixture: no upstream account or model requests.
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const home = process.env.CODEX_HOME;
await mkdir(home, { recursive: true, mode: 0o700 });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const result = (id, value) => send({ id, result: value });
const stateFile = path.join(home, 'fake-threads.json');
let threads = JSON.parse(await readFile(stateFile, 'utf8').catch(() => '{}'));
let writes = Promise.resolve();
const persist = () => {
  const contents = JSON.stringify(threads);
  writes = writes.then(async () => {
    const temporary = stateFile + '-' + randomUUID();
    await writeFile(temporary, contents);
    await rename(temporary, stateFile);
  });
  return writes;
};
let initialized = false,
  login = null,
  timer,
  active = null;
let refreshCount = Number(
  await readFile(path.join(home, 'refresh-count'), 'utf8').catch(() => '0'),
);
const jwt = () =>
  'test.' +
  Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'test-account',
        chatgpt_plan_type: 'plus',
      },
    }),
  ).toString('base64url') +
  '.test';
async function authenticate() {
  await writeFile(
    path.join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: jwt(),
        refresh_token: 'refresh-token-never-leaves-auth-home',
        id_token: 'test-id-token',
        account_id: 'test-account',
      },
    }),
    { mode: 0o600 },
  );
}
async function finish(status = 'completed') {
  if (!active) return;
  active.turn.status = status;
  const completed = active;
  active = null;
  await persist();
  notify('turn/completed', { threadId: completed.threadId, turn: completed.turn });
}
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const message = JSON.parse(line);
  const { id, method, params = {} } = message;
  if (!method) {
    notify('serverRequest/resolved', { requestId: id });
    if (id === 701) {
      await finish();
    }
    return;
  }
  await writeFile(path.join(home, 'methods'), method + '\n', { flag: 'a' });
  try {
    if (method === 'initialize') {
      if (initialized) throw new Error('Already initialized');
      initialized = true;
      result(id, { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' });
      return;
    }
    if (!initialized) throw new Error('Not initialized');
    if (method === 'initialized') return;
    if (method === 'account/read') {
      if (params.refreshToken) {
        await new Promise((r) => setTimeout(r, 40));
        await authenticate();
        await writeFile(path.join(home, 'refresh-count'), String(++refreshCount));
      }
      const signedIn = await readFile(path.join(home, 'auth.json'), 'utf8')
        .then(() => true)
        .catch(() => false);
      result(id, {
        account: signedIn
          ? { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' }
          : null,
        requiresOpenaiAuth: true,
        workspaceRouting: null,
      });
      return;
    }
    if (method === 'account/login/start') {
      if (params.type === 'chatgptAuthTokens') {
        result(id, { type: 'chatgptAuthTokens' });
        return;
      }
      login = randomUUID();
      result(id, {
        type: 'chatgptDeviceCode',
        loginId: login,
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'TEST-CODE',
      });
      timer = setTimeout(async () => {
        if (
          await readFile(path.join(home, 'login-fails'))
            .then(() => true)
            .catch(() => false)
        ) {
          notify('account/login/completed', { loginId: login, success: false, error: 'Expired' });
          return;
        }
        await authenticate();
        notify('account/login/completed', { loginId: login, success: true, error: null });
      }, 200);
      return;
    }
    if (method === 'account/login/cancel') {
      clearTimeout(timer);
      result(id, { status: 'canceled' });
      notify('account/login/completed', {
        loginId: params.loginId,
        success: false,
        error: 'Cancelled',
      });
      return;
    }
    if (method === 'account/logout') {
      clearTimeout(timer);
      await unlink(path.join(home, 'auth.json')).catch(() => {});
      result(id, {});
      return;
    }
    if (method === 'thread/start') {
      const thread = {
        id: randomUUID(),
        name: null,
        cwd: params.cwd,
        modelProvider: params.modelProvider,
        parentThreadId: null,
        turns: [],
        preview: '',
        status: { type: 'idle' },
      };
      threads[thread.id] = thread;
      await persist();
      result(id, { thread });
      notify('thread/started', { thread });
      return;
    }
    if (method === 'thread/list') {
      result(id, {
        data: Object.values(threads).filter((thread) => !!thread.archived === !!params.archived),
        nextCursor: null,
      });
      return;
    }
    if (method === 'model/list') {
      result(id, {
        data: [
          {
            id: 'fake-model',
            model: 'fake-model',
            displayName: 'Fake model',
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
            isDefault: true,
          },
        ],
        nextCursor: null,
      });
      return;
    }
    const thread = threads[params.threadId];
    if (method.startsWith('thread/') || method.startsWith('turn/')) {
      if (!thread) throw new Error('Thread not found in this project');
    }
    if (method === 'thread/read' || method === 'thread/resume') {
      if (method === 'thread/read' && params.includeTurns && !thread.turns.length)
        throw new Error(
          `thread ${thread.id} is not materialized yet; includeTurns is unavailable before first user message`,
        );
      result(id, { thread });
      return;
    }
    if (method === 'thread/fork') {
      const copy = structuredClone(thread);
      copy.id = randomUUID();
      threads[copy.id] = copy;
      await persist();
      result(id, { thread: copy });
      return;
    }
    if (method === 'thread/name/set') {
      thread.name = params.name;
      await persist();
      result(id, {});
      return;
    }
    if (method === 'thread/archive' || method === 'thread/unarchive') {
      thread.archived = method === 'thread/archive';
      await persist();
      result(id, { thread });
      return;
    }
    if (method === 'turn/start') {
      if (active) throw new Error('Already active');
      const turn = {
        id: randomUUID(),
        status: 'inProgress',
        items: [{ id: randomUUID(), type: 'userMessage', content: params.input }],
        error: null,
      };
      thread.turns.push(turn);
      thread.preview = params.input[0].text;
      active = { threadId: thread.id, turn };
      const text = params.input[0].text;
      if (text === 'crash') {
        process.exit(2);
      }
      await persist();
      result(id, { turn });
      notify('turn/started', { threadId: thread.id, turn });
      for (const item of turn.items)
        notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
      const item = {
        id: randomUUID(),
        type: 'agentMessage',
        text: '',
        phase: 'final',
        memoryCitation: null,
        delivery: null,
        questions: null,
      };
      turn.items.push(item);
      notify('item/started', { threadId: thread.id, turnId: turn.id, item });
      item.text = 'Hello from Codex';
      notify('item/agentMessage/delta', {
        threadId: thread.id,
        turnId: turn.id,
        itemId: item.id,
        delta: item.text,
      });
      if (text === 'question') {
        send({
          id: 701,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: item.id,
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: 'choice',
                header: 'Choice',
                question: 'Which option?',
                isOther: true,
                isSecret: false,
                options: [{ label: 'A', description: 'First option' }],
              },
            ],
          },
        });
      }
      if (text === 'unsupported')
        send({
          id: 702,
          method: 'item/tool/call',
          params: {
            threadId: thread.id,
            turnId: turn.id,
            callId: 'unknown',
            tool: 'unknown',
            arguments: {},
          },
        });
      if (text === 'refresh')
        send({
          id: 703,
          method: 'account/chatgptAuthTokens/refresh',
          params: { reason: 'unauthorized', previousAccountId: 'test-account' },
        });
      if (!['question', 'hold', 'unsupported', 'refresh'].includes(text))
        setTimeout(() => finish(), 40);
      return;
    }
    if (method === 'turn/steer') {
      if (active?.turn.id !== params.expectedTurnId) throw new Error('Turn mismatch');
      result(id, { turnId: active.turn.id });
      return;
    }
    if (method === 'turn/interrupt') {
      await finish('interrupted');
      result(id, {});
      return;
    }
    throw new Error('Unsupported method');
  } catch (error) {
    send({ id, error: { code: -32602, message: error.message } });
  }
});
