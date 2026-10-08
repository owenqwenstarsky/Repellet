import { useEffect, useRef, useState } from 'react';
import { workspaceEventSchema } from '@repellet/shared';
import { wsUrl } from '../api';
import { WorkspaceSession } from './session';
export type WorkspaceEvent = { type: string; [key: string]: any };
// Keep the cursor through disconnects. Initial attachment and expired cursors refresh the snapshot.
export function useWorkspaceSocket(
  id: string,
  enabled: boolean,
  role: string | undefined,
  handlers: { onMessage: (message: WorkspaceEvent) => void; onRevoked: (reason: string) => void },
) {
  const [connected, setConnected] = useState(false);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!enabled) return;
    const session = new WorkspaceSession(id);
    let socket: WebSocket | null = null,
      reconnect: ReturnType<typeof setTimeout> | undefined,
      disposed = false;
    function connect() {
      if (disposed) return;
      const query = `?protocol=1${session.cursor === undefined ? '' : `&cursor=${session.cursor}`}`;
      socket = new WebSocket(wsUrl(`/ws/projects/${id}/events${query}`));
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'event') {
            const parsed = workspaceEventSchema.parse(message.event);
            const result = session.accept(parsed, (current) =>
              latest.current.onMessage(current.payload as WorkspaceEvent),
            );
            if (result === 'resync') {
              session.cursor = undefined;
              socket?.close(4000, 'Workspace sequence changed');
            }
          } else if (message.type === 'resync-required' || message.type === 'ready') {
            if (!Number.isSafeInteger(message.cursor) || message.cursor < 0)
              throw new Error('Invalid workspace cursor');
            session.cursor = message.cursor;
            latest.current.onMessage({ type: 'resync', reason: message.reason });
          } else latest.current.onMessage(message); // Compatibility with pre-migration servers.
        } catch {
          session.cursor = undefined;
          socket?.close(4000, 'Workspace event could not be applied');
        }
      };
      socket.onclose = (e) => {
        if (disposed) return;
        setConnected(false);
        if (e.code === 1008) {
          latest.current.onRevoked(e.reason || 'Project access changed.');
          return;
        }
        reconnect = setTimeout(connect, 2000);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      socket?.close();
      setConnected(false);
    };
  }, [id, enabled, role]);
  return { connected };
}
