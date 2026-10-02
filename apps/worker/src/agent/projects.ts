import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  agentRpcSchema,
  projectAgentEvent,
  type AgentEvent,
  type AgentSnapshot,
  type AgentPrivateSettings,
  type AgentQuestion,
} from '@repellet/shared';
import type { ServerRequest, ServerNotification, Thread } from '@repellet/codex-protocol';
import { CodexConnection } from './connection.js';
import { withAccount, privateSettings, accessTokens } from './accounts.js';
import { startProjectProcess, killProjectAgent, projectAgentBytes } from './process.js';
import { bridgeRequest } from '../workspaces.js';
import { hydrateLegacyTools } from './legacy-history.js';
type Session = {
  userId: string;
  projectId: string;
  connection: CodexConnection;
  snapshot: AgentSnapshot;
  clients: Set<WebSocket>;
  settings: AgentPrivateSettings;
  starting: boolean;
  threads: Map<string, Thread>;
  loadedThreads: Set<string>;
  completedTurns: Set<string>;
};
const sessions = new Map<string, Session>();
const starts = new Map<string, Promise<Session>>();
const busy = (session: Session) => session.starting || !!session.snapshot.active;
const error = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
function redact<T>(value: T, settings: AgentPrivateSettings): T {
  if (!settings.apiKey) return value;
  return JSON.parse(
    JSON.stringify(value).replaceAll(JSON.stringify(settings.apiKey).slice(1, -1), '[redacted]'),
  );
}
function publish(
  session: Session,
  event:
    | Omit<Extract<AgentEvent, { type: 'event' }>, 'generation' | 'sequence'>
    | {
        type: 'question';
        question: AgentQuestion;
      }
    | { type: 'question/resolved'; requestId: string | number }
    | { type: 'process/error'; message: string },
) {
  const message = redact(
    { ...event, generation: session.snapshot.generation, sequence: session.snapshot.sequence + 1 },
    session.settings,
  ) as AgentEvent;
  session.snapshot = projectAgentEvent(session.snapshot, message);
  for (const client of session.clients)
    if (client.readyState === 1) client.send(JSON.stringify(message));
}
async function serverRequest(session: Session, request: ServerRequest) {
  const connection = session.connection;
  try {
    if (request.method === 'account/chatgptAuthTokens/refresh') {
      if (session.settings.mode !== 'chatgpt')
        throw new Error('Custom provider cannot refresh ChatGPT');
      const tokens = await accessTokens(session.userId);
      if (
        request.params.previousAccountId &&
        request.params.previousAccountId !== tokens.chatgptAccountId
      )
        throw new Error('ChatGPT account changed. Reconnect your agent.');
      connection.respond(request.id, tokens);
    } else if (request.method === 'item/tool/requestUserInput') {
      publish(session, {
        type: 'question',
        question: {
          id: request.id,
          params: request.params,
          displayThreadId: session.snapshot.active?.threadId || request.params.threadId,
        },
      });
    } else if (request.method === 'currentTime/read') {
      connection.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
    } else {
      connection.reject(
        request.id,
        `Repellet does not support ${request.method}. Use built-in tools or ask the owner in text.`,
      );
      publish(session, {
        type: 'process/error',
        message: `Codex requested an unsupported operation (${request.method}). Reopen the agent to continue.`,
      });
      await connection.close();
    }
  } catch {
    if (!connection.closed)
      connection.reject(request.id, 'Reconnect your account in Agent settings to continue');
  }
}
async function getSession(projectId: string, userId: string) {
  const existing = sessions.get(projectId);
  if (existing && existing.userId !== userId) throw error('Project owner mismatch', 403);
  if (existing && !existing.connection.closed) return existing;
  if (!starts.has(projectId))
    starts.set(
      projectId,
      (async () => {
        if (existing?.connection.closed) await existing.connection.close();
        const settings = await privateSettings(userId);
        if (
          settings.mode === 'custom' &&
          (!settings.apiKey || !settings.baseUrl || !settings.model)
        )
          throw error('Configure your custom provider in Agent settings');
        const tokens = settings.mode === 'chatgpt' ? await accessTokens(userId) : null;
        const connection = await startProjectProcess(projectId, settings);
        const session: Session = {
          projectId,
          userId,
          connection,
          settings,
          clients: existing?.clients || new Set(),
          starting: false,
          threads: new Map(),
          loadedThreads: new Set(),
          completedTurns: new Set(),
          snapshot: {
            generation: randomUUID(),
            sequence: 0,
            connected: true,
            active: null,
            waiting: false,
            pending: [],
            items: [],
            error: null,
          },
        };
        sessions.set(projectId, session);
        connection.on('request', (request) => {
          void serverRequest(session, request);
        });
        connection.on('notification', (event: ServerNotification) => {
          if (event.method === 'thread/started') {
            session.threads.set(event.params.thread.id, event.params.thread);
            session.loadedThreads.add(event.params.thread.id);
          }
          if (event.method === 'turn/completed') {
            session.completedTurns.add(event.params.turn.id);
            if (session.completedTurns.size > 200)
              session.completedTurns.delete(session.completedTurns.values().next().value!);
          }
          if (
            event.method === 'turn/started' &&
            !session.threads.get(event.params.threadId)?.parentThreadId
          )
            session.starting = false;
          if (
            'threadId' in event.params &&
            typeof event.params.threadId === 'string' &&
            session.threads.get(event.params.threadId)?.parentThreadId &&
            event.method.startsWith('turn/')
          )
            return;
          // Legacy raw events can contain duplicate data and auth/config details.
          if (!/^(thread\/|turn\/|item\/|error$|serverRequest\/resolved$)/.test(event.method))
            return;
          publish(session, { type: 'event', event });
        });
        connection.on('failure', (message) => {
          session.starting = false;
          publish(session, { type: 'process/error', message });
        });
        try {
          await connection.initialize();
          if (tokens)
            await connection.call('account/login/start', { type: 'chatgptAuthTokens', ...tokens });
          for (const client of session.clients)
            if (client.readyState === 1)
              client.send(JSON.stringify({ type: 'snapshot', snapshot: session.snapshot }));
          return session;
        } catch (e) {
          await connection.close();
          throw e;
        }
      })().finally(() => starts.delete(projectId)),
    );
  return starts.get(projectId)!;
}
export async function agentStatus(projectId: string, userId: string) {
  return withAccount(userId, async () => (await getSession(projectId, userId)).snapshot);
}
export function agentActivity(projectId: string) {
  const session = sessions.get(projectId);
  return {
    executing: !!session && busy(session) && !session.snapshot.waiting,
    active: !!session && busy(session),
  };
}
export function assertAccountIdle(userId: string) {
  if ([...sessions.values()].some((session) => session.userId === userId && busy(session)))
    throw error('Stop active agent turns before changing settings or replacing your ChatGPT login');
}
export async function closeUserAgents(userId: string, projectId?: string) {
  for (const session of [...sessions.values()])
    if (session.userId === userId && (!projectId || session.projectId === projectId))
      await stopAgent(session.projectId);
}
export async function stopAgent(projectId: string) {
  const pending = starts.get(projectId);
  if (pending) await pending.catch(() => {});
  const session = sessions.get(projectId);
  if (session) {
    if (session.snapshot.active && !session.connection.closed)
      await session.connection.call('turn/interrupt', session.snapshot.active).catch(() => {});
    await session.connection.close();
    for (const client of session.clients) client.close(1012, 'Agent stopped');
    sessions.delete(projectId);
  } else await killProjectAgent(projectId);
}
export async function attachAgent(client: WebSocket, projectId: string, userId: string) {
  const session = await withAccount(userId, () => getSession(projectId, userId));
  if (client.readyState !== 1) return;
  // Synchronous registration + snapshot serialization gives an atomic boundary.
  session.clients.add(client);
  client.send(JSON.stringify({ type: 'snapshot', snapshot: session.snapshot }));
  client.on('close', () => session.clients.delete(client));
}
export async function agentRpc(projectId: string, userId: string, input: unknown) {
  const rpc = agentRpcSchema.parse(input);
  return withAccount(userId, async () => {
    const session = await getSession(projectId, userId);
    if (rpc.generation !== session.snapshot.generation)
      throw error('Agent process changed. Refresh status and history before continuing.');
    const { connection, settings } = session;
    const params = { ...rpc.params };
    if (params.threadId) {
      // Read by ID from this project's private CODEX_HOME; never accept rollout paths/history.
      const thread =
        session.threads.get(params.threadId) ||
        ((await connection.call('thread/read', { threadId: params.threadId, includeTurns: false }))
          .thread as Thread);
      session.threads.set(thread.id, thread);
      if (thread.cwd !== '/workspace') throw error('Thread does not belong to this project', 403);
      if (thread.parentThreadId) throw error('Subagent threads cannot receive top-level turns');
    }
    const active = session.snapshot.active;
    if (rpc.method === 'turn/start' || rpc.method === 'thread/compact/start') {
      if (busy(session)) throw error('This project already has an active agent turn');
      const usage = await agentUsage(projectId);
      if (usage.exceeded)
        throw error('Project storage limit reached. Delete files to continue.', 507);
    }
    if (
      rpc.method === 'turn/steer' &&
      (!active || active.threadId !== params.threadId || active.turnId !== params.expectedTurnId)
    )
      throw error('Active turn changed. Refresh the conversation.');
    if (
      rpc.method === 'turn/interrupt' &&
      (!active || active.threadId !== params.threadId || active.turnId !== params.turnId)
    )
      throw error('This turn is no longer active');
    if (
      ['thread/resume', 'thread/fork', 'thread/archive', 'thread/unarchive'].includes(rpc.method) &&
      active?.threadId === params.threadId
    )
      throw error('Stop the active turn before changing this thread');
    if (rpc.method === 'question/respond') {
      const question = session.snapshot.pending.find(
        (question) => question.id === params.requestId,
      );
      if (!question) throw error('Question is no longer pending');
      const ids = question.params.questions.map((q) => q.id);
      if (
        Object.keys(params.answers).some((id) => !ids.includes(id)) ||
        ids.some((id) => !params.answers[id])
      )
        throw error('Answer each pending question', 400);
      connection.respond(question.id, { answers: params.answers });
      publish(session, { type: 'question/resolved', requestId: question.id });
      return { ok: true };
    }
    // Local 0.160.0 does not implement list_turns for its paginated history store.
    // Select Codex's supported durable rollout history contract explicitly.
    if (rpc.method === 'thread/start') params.historyMode = 'legacy';
    if (rpc.method === 'thread/list')
      Object.assign(params, { cwd: '/workspace', modelProviders: [] });
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(rpc.method))
      Object.assign(params, {
        cwd: '/workspace',
        modelProvider: settings.mode === 'custom' ? 'repellet' : 'openai',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        ...(settings.mode === 'custom' ? { model: settings.model } : {}),
      });
    if (rpc.method === 'turn/start') {
      // Always resume under the currently selected provider; thread/read does not load it.
      if (!session.loadedThreads.has(params.threadId))
        await connection.call('thread/resume', {
          threadId: params.threadId,
          cwd: '/workspace',
          modelProvider: settings.mode === 'custom' ? 'repellet' : 'openai',
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          ...(settings.mode === 'custom' ? { model: settings.model } : {}),
        });
      session.loadedThreads.add(params.threadId);
      Object.assign(params, {
        cwd: '/workspace',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(settings.mode === 'custom'
          ? { model: settings.model, effort: settings.effort ?? undefined }
          : {}),
      });
    }
    const executing = rpc.method === 'turn/start' || rpc.method === 'thread/compact/start';
    if (executing) session.starting = true;
    try {
      let result;
      try {
        result = await connection.call(rpc.method, params);
      } catch (e) {
        const known = session.threads.get(params.threadId);
        // Codex creates its rollout on the first turn. Empty live threads still belong
        // to this process generation and can be displayed before that first turn.
        if (
          rpc.method === 'thread/read' &&
          params.includeTurns &&
          /not materialized yet; includeTurns is unavailable before first user message/.test(
            (e as Error).message,
          )
        )
          result = await connection.call('thread/read', {
            threadId: params.threadId,
            includeTurns: false,
          });
        else if (
          rpc.method === 'thread/read' &&
          known &&
          !known.turns.length &&
          /no rollout found/.test((e as Error).message)
        )
          result = { thread: known };
        else {
          session.starting = false;
          throw e;
        }
      }
      if (result.thread) {
        if (rpc.method === 'thread/read' && params.includeTurns)
          result.thread = await hydrateLegacyTools(connection, result.thread);
        session.threads.set(result.thread.id, { ...result.thread, turns: [] });
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(rpc.method))
          session.loadedThreads.add(result.thread.id);
      }
      if (
        rpc.method === 'turn/start' &&
        result.turn?.status === 'inProgress' &&
        !session.completedTurns.has(result.turn.id) &&
        !session.snapshot.active
      )
        session.snapshot = {
          ...session.snapshot,
          active: { threadId: params.threadId, turnId: result.turn.id },
        };
      return redact(result, settings);
    } finally {
      if (
        executing &&
        (rpc.method !== 'thread/compact/start' || session.snapshot.active || connection.closed)
      )
        session.starting = false;
    }
  });
}
export async function agentUsage(projectId: string) {
  const agentBytes = await projectAgentBytes(projectId);
  await bridgeRequest(projectId, '/agent-usage', 'PUT', { bytes: agentBytes });
  const usage = (await (await bridgeRequest(projectId, '/usage')).json()) as {
    bytes: number;
    exceeded: boolean;
  };
  if (usage.exceeded && agentActivity(projectId).active) await stopAgent(projectId);
  return usage;
}
export async function closeAllAgents() {
  for (const id of [...sessions.keys()]) await stopAgent(id);
}
