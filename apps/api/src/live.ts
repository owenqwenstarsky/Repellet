import type { WebSocket } from 'ws';
import { userForToken } from './security.js';
type Connection = {
  ws: WebSocket;
  userId: string;
  projectId: string;
  token: string;
  events: boolean;
  displayName: string;
};
const connections = new Set<Connection>();
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
  const connection = { ws, ...data };
  connections.add(connection);
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
    if (c.projectId === projectId && c.events && c.ws.readyState === 1)
      c.ws.send(JSON.stringify(event));
}
function presence(projectId: string) {
  const peers = [
    ...new Map(
      [...connections]
        .filter((c) => c.events && c.projectId === projectId)
        .map((c) => [c.userId, { id: c.userId, name: c.displayName }]),
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
  const tokens = new Map([...connections].map((c) => [c.token, c.userId]));
  for (const [token, userId] of tokens)
    try {
      if (!(await userForToken(token)))
        for (const c of connections) if (c.token === token) c.ws.close(1008, 'Session expired');
    } catch {}
}, 30000);
timer.unref();
