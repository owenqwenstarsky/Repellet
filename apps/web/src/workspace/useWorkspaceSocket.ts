import { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api';
export type WorkspaceEvent = { type: string; [key: string]: any };
// Project event stream with reconnect. Handlers live in a ref so they never go stale.
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
    let socket: WebSocket | null = null,
      reconnect: ReturnType<typeof setTimeout> | undefined,
      disposed = false;
    function connect() {
      if (disposed) return;
      socket = new WebSocket(wsUrl(`/ws/projects/${id}/events`));
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        try {
          latest.current.onMessage(JSON.parse(event.data));
        } catch {}
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
