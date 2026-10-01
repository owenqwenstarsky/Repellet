import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../apps/api/src/db.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    transaction: async (operation: (tx: unknown) => Promise<void>) => operation({}),
  },
}));
vi.mock('../apps/api/src/security.js', () => ({ userForToken: vi.fn() }));
vi.mock('../apps/api/src/worker.js', () => ({ bridge: vi.fn() }));

import { structure } from '../apps/api/src/collaboration.js';
import { emit, track } from '../apps/api/src/live.js';

const sockets: EventEmitter[] = [];
function listen(projectId: string) {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() });
  sockets.push(socket);
  track(socket as unknown as WebSocket, {
    projectId,
    userId: 'user',
    token: 'token',
    events: true,
    displayName: 'User',
  });
  socket.send.mockClear();
  return () => socket.send.mock.calls.map(([message]) => JSON.parse(message));
}
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.emit('close');
});

describe('structural change event ordering', () => {
  it.each([
    ['src/one.ts', 'src/renamed.ts', 'unlink'],
    ['src', 'lib', 'unlinkDir'],
    ['src/one.ts', undefined, 'unlink'],
  ])('publishes %s remapping before its watcher removal', async (from, to, event) => {
    const received = listen('project');
    const removal = { type: 'file', event, path: from };
    await structure('project', from, to, async () => {
      emit('project', removal);
      // Allow the browser to process the removal before the database update completes.
      await new Promise((resolve) => setImmediate(resolve));
      expect(received()).toEqual([]);
      return { ok: true };
    });
    expect(received()).toEqual([{ type: 'structure', from, to: to || null }, removal]);
  });

  it('releases watcher events after failure and keeps other projects and event types live', async () => {
    const received = listen('project');
    const other = listen('other');
    const removal = { type: 'file', event: 'unlink', path: 'one.ts' };
    await expect(
      structure('project', 'one.ts', 'renamed.ts', async () => {
        emit('project', removal);
        emit('project', { type: 'terminals' });
        emit('other', removal);
        expect(received()).toEqual([{ type: 'terminals' }]);
        expect(other()).toEqual([removal]);
        throw new Error('Move failed');
      }),
    ).rejects.toThrow('Move failed');
    emit('project', { type: 'file', event: 'add', path: 'two.ts' });
    expect(received()).toEqual([
      { type: 'terminals' },
      removal,
      { type: 'file', event: 'add', path: 'two.ts' },
    ]);
  });
});
