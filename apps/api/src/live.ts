import type { WebSocket } from 'ws';
import { userForToken } from './security.js';
import { appendWorkspaceEvent, replayWorkspaceEvents, workspaceCursor } from './workspaceEvents.js';
import { WorkspaceQueue } from './workspaceQueue.js';
import { workspaceContext } from './workspaceContext.js';
import type { WorkspaceEvent } from '@repellet/shared';
type Connection = {
  ws: WebSocket;
  userId: string;
  projectId: string;
  token: string;
  events: boolean;
  displayName: string;
  protocol?: 'legacy' | 'sequenced';
  role?: import('@repellet/shared').ProjectRole;
  lastPong?: number;
};
const connections = new Set<Connection>();
const delivery = new WorkspaceQueue();
let journalEnabled = false;
export function enableWorkspaceJournal() {
  journalEnabled = true;
}
export const drainWorkspaceEvents = () => delivery.drain();
export const workspaceConnectionCount = (projectId: string) =>
  [...connections].filter((connection) => connection.projectId === projectId).length;
export async function closeWorkspaceConnections() {
  await Promise.all(
    [...connections].map(
      ({ ws }) =>
        new Promise<void>((resolve) => {
          ws.once('close', () => resolve());
          ws.terminate();
        }),
    ),
  );
  await delivery.drain();
}
export function subscribeWorkspaceEvents(
  ws: WebSocket,
  data: Omit<Connection, 'ws'>,
  cursor?: number,
) {
  return delivery.run(data.projectId, async () => {
    const replay =
      cursor === undefined ? null : await replayWorkspaceEvents(data.projectId, cursor);
    const current = replay?.cursor ?? (await workspaceCursor(data.projectId));
    if (ws.readyState !== 1) return;
    // Nothing can publish between this registration and the replay boundary.
    track(ws, { ...data, protocol: 'sequenced' });
    if (!replay || replay.kind === 'resync')
      ws.send(
        JSON.stringify({
          type: 'resync-required',
          version: 1,
          cursor: current,
          reason: replay?.reason ?? 'initial',
        }),
      );
    else {
      for (const event of replay.events) ws.send(JSON.stringify({ type: 'event', event }));
      ws.send(JSON.stringify({ type: 'ready', version: 1, cursor: current }));
    }
  });
}
const deferredFiles = new Map<string, unknown[]>();
/** Publish watcher events after the structural change that explains their paths. */
export function deferFileEvents(projectId: string) {
  const events: unknown[] = [];
  deferredFiles.set(projectId, events);
  return () => {
    deferredFiles.delete(projectId);
    for (const event of events) emit(projectId, event);
  };
}
export function track(ws: WebSocket, data: Omit<Connection, 'ws'>) {
  const connection = { ws, ...data, lastPong: Date.now() };
  connections.add(connection);
  ws.on('pong', () => {
    connection.lastPong = Date.now();
  });
  if (data.events) presence(data.projectId);
  ws.on('close', () => {
    connections.delete(connection);
    if (data.events) presence(data.projectId);
  });
  return connection;
}
export function emit(projectId: string, event: unknown) {
  const deferred = deferredFiles.get(projectId);
  if (deferred && (event as { type?: string } | null)?.type === 'file') {
    deferred.push(event);
    return;
  }
  for (const c of connections)
    if (
      c.projectId === projectId &&
      c.events &&
      c.protocol !== 'sequenced' &&
      c.ws.readyState === 1
    )
      c.ws.send(JSON.stringify(event));
  const rawType = (event as { type?: string } | null)?.type;
  const type =
    rawType &&
    [
      'presence',
      'document',
      'file',
      'structure',
      'process',
      'terminal',
      'preview',
      'agent',
      'project',
      'error',
    ].includes(rawType)
      ? (rawType as import('@repellet/shared').WorkspaceEvent['type'])
      : rawType === 'files'
        ? 'file'
        : rawType === 'conflict'
          ? 'document'
          : rawType === 'app'
            ? 'preview'
            : [
                  'state',
                  'storage',
                  'preparation',
                  'preparation-log',
                  'database',
                  'environment',
                ].includes(rawType || '')
              ? 'project'
              : rawType === 'terminals'
                ? 'terminal'
                : undefined;
  if (type && journalEnabled) {
    const context = workspaceContext.getStore();
    const actor = context?.projectId === projectId ? context.actor : undefined;
    const pending = delivery.run(projectId, async () => {
      const saved = await appendWorkspaceEvent({
        projectId,
        type,
        payload: event,
        actor,
        action: ['structure', 'process', 'project'].includes(type) ? rawType : undefined,
      });
      for (const c of connections)
        if (
          c.projectId === projectId &&
          c.events &&
          c.protocol === 'sequenced' &&
          c.ws.readyState === 1
        ) {
          if (c.ws.bufferedAmount > 4 * 1024 * 1024)
            c.ws.close(1013, 'Reconnect to replay workspace events');
          else c.ws.send(JSON.stringify({ type: 'event', event: saved }));
        }
    });
    // Synchronous watcher callers cannot await. Closing prevents accepting a false cursor.
    void pending.catch(() => {
      for (const c of connections)
        if (c.projectId === projectId && c.protocol === 'sequenced')
          c.ws.close(1011, 'Workspace event persistence unavailable');
    });
    return pending;
  }
}
function presence(projectId: string) {
  const peers = [
    ...new Map(
      [...connections]
        .filter((c) => c.events && c.projectId === projectId)
        .map((c) => [c.userId, { id: c.userId, name: c.displayName, role: c.role }]),
    ).values(),
  ];
  emit(projectId, { type: 'presence', peers });
}
export function revokeToken(token: string) {
  for (const c of connections) if (c.token === token) c.ws.close(1008, 'Session ended');
}
export function revokeUser(userId: string, projectId?: string) {
  for (const c of connections)
    if (c.userId === userId && (!projectId || c.projectId === projectId))
      c.ws.close(1008, 'Access revoked');
}
export function closeProject(projectId: string, reason = 'Workspace stopped') {
  for (const c of connections) if (c.projectId === projectId) c.ws.close(1012, reason);
}
export const hasClients = (projectId: string) =>
  [...connections].some((c) => c.projectId === projectId && c.ws.readyState === 1);
export const hasEventClient = (projectId: string) =>
  [...connections].some((c) => c.projectId === projectId && c.events && c.ws.readyState === 1);
const timer = setInterval(async () => {
  for (const c of connections) {
    if (Date.now() - (c.lastPong ?? 0) > 65000) c.ws.terminate();
    else if (c.ws.readyState === 1) c.ws.ping?.();
  }
  const tokens = new Map([...connections].map((c) => [c.token, c.userId]));
  for (const [token, userId] of tokens)
    try {
      if (!(await userForToken(token)))
        for (const c of connections) if (c.token === token) c.ws.close(1008, 'Session expired');
    } catch {}
}, 30000);
timer.unref();
