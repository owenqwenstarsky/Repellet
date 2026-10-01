import { useEffect, useRef } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { wsUrl } from './api';
import { fonts, xtermTheme } from './theme';
export function Terminal({
  projectId,
  id,
  editable,
}: {
  projectId: string;
  id: string;
  editable: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const terminal = new XTerminal({
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: editable,
      disableStdin: !editable,
      scrollback: 5000,
      theme: xtermTheme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    fit.fit();
    let socket: WebSocket | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      disposed = false;
    const resize = () => {
      try {
        fit.fit();
        if (editable && socket?.readyState === 1)
          socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      } catch {}
    };
    function connect() {
      if (disposed) return;
      socket = new WebSocket(
        wsUrl(
          `/ws/projects/${projectId}/channel?path=${encodeURIComponent(`/terminals/${id}/connect`)}`,
        ),
      );
      let first = true;
      socket.onopen = resize;
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'output') {
            if (first) {
              terminal.clear();
              terminal.reset();
              first = false;
            }
            terminal.write(message.data);
          }
          if (message.type === 'status') resize();
        } catch {}
      };
      socket.onclose = (event) => {
        if (disposed) return;
        if (event.code === 1008) {
          terminal.write(`\r\n\x1b[90m[${event.reason || 'Access revoked'}]\x1b[0m\r\n`);
          return;
        }
        terminal.write('\r\n\x1b[90m[Reconnecting…]\x1b[0m\r\n');
        timer = setTimeout(connect, 2000);
      };
    }
    connect();
    const input = terminal.onData((data) => {
      if (editable && socket?.readyState === 1)
        socket.send(JSON.stringify({ type: 'input', data }));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element.current);
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [projectId, id, editable]);
  return <div className="terminal-canvas" ref={element} aria-label="Shared terminal" />;
}
