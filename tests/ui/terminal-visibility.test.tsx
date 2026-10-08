// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Terminal } from '../../apps/web/src/Terminal';
const mocks = vi.hoisted(() => ({
  fit: vi.fn(),
  dispose: vi.fn(),
  write: vi.fn(),
  input: null as null | ((data: string) => void),
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    clear() {}
    reset() {}
    write = mocks.write;
    dispose = mocks.dispose;
    onData(fn: (data: string) => void) {
      mocks.input = fn;
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));
vi.mock('../../apps/web/src/api', () => ({ wsUrl: (path: string) => path }));

it('keeps the socket and output alive but suspends fitting, resize and input while hidden', () => {
  mocks.fit.mockClear();
  mocks.dispose.mockClear();
  mocks.write.mockClear();
  const sockets: any[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      readyState = 1;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
  const props = { projectId: 'project', id: 'shell', editable: true };
  const view = render(<Terminal {...props} visible />);
  const socket = sockets[0];
  socket.onopen();
  expect(mocks.fit).toHaveBeenCalled();
  view.rerender(<Terminal {...props} visible={false} />);
  mocks.fit.mockClear();
  socket.send.mockClear();
  socket.onmessage({ data: JSON.stringify({ type: 'status' }) });
  socket.onmessage({ data: JSON.stringify({ type: 'output', data: 'background output' }) });
  mocks.input?.('ignored');
  expect(mocks.fit).not.toHaveBeenCalled();
  expect(socket.send).not.toHaveBeenCalled();
  expect(mocks.write).toHaveBeenCalledWith('background output');
  expect(socket.close).not.toHaveBeenCalled();
  view.rerender(<Terminal {...props} visible />);
  expect(sockets).toHaveLength(1);
  expect(mocks.fit).toHaveBeenCalled();
  expect(JSON.parse(socket.send.mock.calls[0][0]).type).toBe('resize');
  mocks.input?.('command');
  expect(JSON.parse(socket.send.mock.lastCall[0])).toEqual({ type: 'input', data: 'command' });
  view.unmount();
  expect(socket.close).toHaveBeenCalledOnce();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});
