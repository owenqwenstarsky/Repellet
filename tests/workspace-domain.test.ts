import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  hasProjectCapability,
  runProfileInputSchema,
  workspaceCursorSchema,
  type WorkspaceEvent,
} from '@repellet/shared';
import { WorkspaceQueue } from '../apps/api/src/workspaceQueue.js';
import { WorkspaceSession } from '../apps/web/src/workspace/session.js';

describe('workspace contracts', () => {
  it('separates project management, execution, and shared-agent permissions', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      expect(hasProjectCapability(role, 'view')).toBe(true);
      expect(hasProjectCapability(role, 'manage')).toBe(role === 'owner');
      expect(hasProjectCapability(role, 'run')).toBe(role !== 'viewer');
      expect(hasProjectCapability(role, 'agent.execute')).toBe(false);
      const policy = {
        enabled: true,
        provider: 'custom' as const,
        model: 'test',
        reasoningEffort: null,
        credentialConfigured: true,
        editorsCanExecute: true,
        viewersCanObserve: true,
        maxConcurrentTurns: 1 as const,
      };
      expect(hasProjectCapability(role, 'agent.execute', policy)).toBe(role !== 'viewer');
      expect(
        hasProjectCapability(role, 'agent.execute', { ...policy, editorsCanExecute: false }),
      ).toBe(role === 'owner');
      expect(
        hasProjectCapability(role, 'agent.execute', { ...policy, credentialConfigured: false }),
      ).toBe(false);
    }
  });
  it('rejects unsafe paths, unsafe cursors and undocumented run-profile fields', () => {
    for (const cwd of ['../outside', '/etc', 'a/../../x', 'C:/root', 'a\\b', 'a\0b'])
      expect(
        runProfileInputSchema.safeParse({ name: 'App', command: 'npm start', cwd }).success,
      ).toBe(false);
    expect(
      runProfileInputSchema.safeParse({ name: 'App', command: 'npm start', secret: 'value' })
        .success,
    ).toBe(false);
    for (const cursor of ['-1', 'Infinity', '1.5', '9007199254740992', 'invalid'])
      expect(workspaceCursorSchema.safeParse(cursor).success).toBe(false);
  });
  it('deduplicates replay, detects gaps and advances only after applying an event', () => {
    const projectId = randomUUID();
    const session = new WorkspaceSession(projectId);
    session.cursor = 7;
    const event: WorkspaceEvent = {
      version: 1,
      projectId,
      seq: 8,
      type: 'structure',
      payload: { from: 'a', to: 'b' },
    };
    let calls = 0;
    expect(session.accept(event, () => calls++)).toBe('applied');
    expect(session.accept(event, () => calls++)).toBe('duplicate');
    expect(session.accept({ ...event, seq: 10 }, () => calls++)).toBe('resync');
    expect(calls).toBe(1);
    expect(() =>
      session.accept({ ...event, seq: 9 }, () => {
        throw new Error('Consumer failed');
      }),
    ).toThrow();
    expect(session.cursor).toBe(8);
    expect(session.accept({ ...event, projectId: randomUUID(), seq: 9 }, () => calls++)).toBe(
      'resync',
    );
  });
  it('keeps document identity through moves and removes deleted identities', () => {
    const session = new WorkspaceSession(randomUUID());
    const doc = { id: randomUUID(), path: 'old.ts', revision: 1, dirty: false, conflict: false };
    session.reconcileDocuments([doc], () => {});
    const moves: [string, string | undefined][] = [];
    session.reconcileDocuments([{ ...doc, path: 'lib/new.ts', revision: 2 }], (from, to) =>
      moves.push([from, to]),
    );
    session.reconcileDocuments([], (from, to) => moves.push([from, to]));
    expect(moves).toEqual([
      ['old.ts', 'lib/new.ts'],
      ['lib/new.ts', undefined],
    ]);
  });
  it('serializes each workspace while allowing other workspaces and recovery from failure', async () => {
    const queue = new WorkspaceQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = queue.run('a', async () => {
      await gate;
      order.push('a1');
      throw new Error('Failure');
    });
    const handled = first.catch(() => {});
    const second = queue.run('a', async () => {
      order.push('a2');
    });
    await queue.run('b', async () => {
      order.push('b');
    });
    expect(order).toEqual(['b']);
    release();
    await Promise.all([handled, second]);
    await queue.drain();
    expect(order).toEqual(['b', 'a1', 'a2']);
    expect(queue.has('a')).toBe(false);
  });
});
