import { randomUUID } from 'node:crypto';
import { resolveAttachmentInputs } from './attachments.js';
import type { WebSocket } from 'ws';
import {
  agentRpcSchema,
  projectAgentEvent,
  redactAgentPayload,
  validQuestionAnswers,
  type AgentEvent,
  type AgentSnapshot,
  type AgentPrivateSettings,
  type AgentQuestion,
} from '@repellet/shared';
import type { ServerRequest, ServerNotification, Thread } from '@repellet/agent-protocol';
import { AgentConnection } from './connection.js';
import { withAccount, privateSettings, accessTokens } from './accounts.js';
import { startProjectProcess, killProjectAgent, projectAgentBytes } from './process.js';
import { bridgeRequest, locked } from '../workspaces.js';
import { forwardProjectControl } from './project-control.js';
type Session = {
  userId: string;
  projectId: string;
  connection: AgentConnection;
  snapshot: AgentSnapshot;
  clients: Set<WebSocket>;
  settings: AgentPrivateSettings;
  starting: boolean;
  threads: Map<string, Thread>;
  loadedThreads: Set<string>;
  completedTurns: Set<string>;
  controls: Map<string | number, AbortController>;
};
const sessions = new Map<string, Session>();
const starts = new Map<string, Promise<Session>>();
const busy = (session: Session) => session.starting || !!session.snapshot.active;
const error = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
function redact<T>(value: T, settings: AgentPrivateSettings): T {
  return redactAgentPayload(value, settings.apiKey ? [settings.apiKey] : []);
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
    publicResult({
      ...event,
      generation: session.snapshot.generation,
      sequence: session.snapshot.sequence + 1,
    }),
    session.settings,
  ) as AgentEvent;
  session.snapshot = projectAgentEvent(session.snapshot, message);
  for (const client of session.clients)
    if (client.readyState === 1) client.send(JSON.stringify(message));
}
function publicResult<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const copy: any = JSON.parse(JSON.stringify(value));
  const scrub = (item: any) => {
    if (!item || typeof item !== 'object') return;
    if ('path' in item && typeof item.path === 'string' && item.cwd === '/workspace')
      item.path = null;
    for (const child of Object.values(item)) if (child && typeof child === 'object') scrub(child);
  };
  scrub(copy);
  return copy;
}

async function serverRequest(session: Session, request: ServerRequest) {
  const connection = session.connection;
  const requestId = request.id,
    requestedMethod: string = request.method;
  try {
    if (request.method === 'repellet/project/control') {
      const controller = new AbortController();
      session.controls.set(request.id, controller);
      try {
        const result = await forwardProjectControl(
          {
            projectId: session.projectId,
            userId: session.userId,
            active: () => session.snapshot.active,
            planMode: (id) => session.threads.get(id)?.planMode === true,
          },
          request.params,
          controller.signal,
        );
        if (!connection.closed) connection.respond(request.id, redact(result, session.settings));
      } finally {
        session.controls.delete(request.id);
      }
    } else if (request.method === 'account/chatgptAuthTokens/refresh') {
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
        requestId,
        `Repellet does not support ${requestedMethod}. Use built-in tools or ask the owner in text.`,
      );
      publish(session, {
        type: 'process/error',
        message: `Agent host requested an unsupported operation (${requestedMethod}). Reopen the agent to continue.`,
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
        const connection = await startProjectProcess(projectId, settings, tokens || undefined);
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
          controls: new Map(),
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
          if (event.method === 'serverRequest/resolved')
            session.controls.get(event.params.requestId)?.abort();
          if (event.method === 'thread/started') {
            session.threads.set(event.params.thread.id, event.params.thread);
            session.loadedThreads.add(event.params.thread.id);
          }
          if (event.method === 'thread/planMode/updated') {
            const thread = session.threads.get(event.params.threadId);
            if (thread) thread.planMode = event.params.enabled;
          }
          if (event.method === 'turn/completed') {
            if (
              session.snapshot.active?.threadId === event.params.threadId &&
              session.snapshot.active.turnId === event.params.turn.id
            )
              for (const controller of session.controls.values()) controller.abort();
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
          for (const controller of session.controls.values()) controller.abort();
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
  await locked(projectId, async () => {
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
  });
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
    if (params.input?.some((item: { type: string }) => item.type === 'attachment'))
      params.input = await resolveAttachmentInputs(projectId, params.input);
    if (params.threadId) {
      // Read by ID from this project's private Pi session directory; never accept rollout paths/history.
      const thread =
        session.threads.get(params.threadId) ||
        ((await connection.call('thread/read', { threadId: params.threadId, includeTurns: false }))
          .thread as Thread);
      session.threads.set(thread.id, thread);
      if (thread.cwd !== '/workspace') throw error('Thread does not belong to this project', 403);
      if (thread.parentThreadId) throw error('Subagent threads cannot receive top-level turns');
    }
    const active = session.snapshot.active;
    if (
      rpc.method === 'turn/start' ||
      rpc.method === 'thread/compact/start' ||
      rpc.method === 'thread/plan/toggle'
    ) {
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
      if (!validQuestionAnswers(question.params.questions, params.answers))
        throw error('Answer each pending question', 400);
      connection.respond(question.id, { answers: params.answers });
      publish(session, { type: 'question/resolved', requestId: question.id });
      return { ok: true };
    }
    if (rpc.method === 'turn/start' && settings.mode === 'custom')
      Object.assign(params, { model: settings.model, effort: settings.effort ?? undefined });
    if (rpc.method === 'turn/interrupt')
      for (const controller of session.controls.values()) controller.abort();
    const executing = rpc.method === 'turn/start' || rpc.method === 'thread/compact/start';
    if (executing) session.starting = true;
    try {
      const result = await connection.call(rpc.method, params);
      if (result.thread) {
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
      return publicResult(redact(result, settings));
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
    limitBytes?: number;
  };
  if (usage.exceeded && agentActivity(projectId).active) await stopAgent(projectId);
  return usage;
}
export async function closeAllAgents() {
  for (const id of [...sessions.keys()]) await stopAgent(id);
}
