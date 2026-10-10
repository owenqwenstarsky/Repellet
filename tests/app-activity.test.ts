import { beforeEach, expect, it, vi } from 'vitest';
import { mainAppRunning } from '../apps/api/src/appActivity.js';
import { mainRunProcessIds } from '../apps/api/src/preparation.js';
import { bridge } from '../apps/api/src/worker.js';

vi.mock('../apps/api/src/preparation.js', () => ({ mainRunProcessIds: vi.fn() }));
vi.mock('../apps/api/src/worker.js', () => ({ bridge: vi.fn() }));

const project = { id: 'project', state: 'running' };
const main = { id: 'main', isRun: true, alive: true };
beforeEach(() => {
  vi.mocked(mainRunProcessIds)
    .mockReset()
    .mockResolvedValue(new Set(['run', 'main']));
  vi.mocked(bridge).mockReset().mockResolvedValue([]);
});

it.each(['stopped', 'building', 'starting', 'stopping', 'failed'])(
  'does not query or start a %s workspace',
  async (state) => {
    expect(await mainAppRunning({ ...project, state })).toBe(false);
    expect(mainRunProcessIds).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  },
);

it('leaves an open workspace without a main app idle', async () => {
  expect(await mainAppRunning(project)).toBe(false);
  expect(mainRunProcessIds).toHaveBeenCalledWith(project.id);
  expect(bridge).toHaveBeenCalledExactlyOnceWith(project.id, '/terminals');
});

it.each(['stopped', 'starting', 'available', 'timeout', 'failed'])(
  'uses live main-app activity independently of HTTP readiness (%s)',
  async (status) => {
    vi.mocked(bridge).mockResolvedValue([main]);
    expect(await mainAppRunning({ ...project, appStatus: { status } } as typeof project)).toBe(
      true,
    );
  },
);

it('recognizes the legacy main Run session', async () => {
  vi.mocked(bridge).mockResolvedValue([{ ...main, id: 'run' }]);
  expect(await mainAppRunning(project)).toBe(true);
});

it('ignores shells, tasks, additional services and unidentified sessions', async () => {
  vi.mocked(bridge).mockResolvedValue([
    { id: 'shell', isRun: false, alive: true },
    { id: 'main', isRun: false, alive: true, kind: 'task' },
    { id: 'additional', isRun: true, alive: true },
    { isRun: true, alive: true },
  ]);
  expect(await mainAppRunning(project)).toBe(false);
});

it.each(['stopped', 'exited', 'failed'])(
  'does not trust recorded process status after the live app is %s',
  async (status) => {
    vi.mocked(bridge).mockResolvedValue([{ ...main, alive: false, status }]);
    expect(await mainAppRunning(project)).toBe(false);
  },
);

it('reports stop, exit and restart using fresh process information', async () => {
  vi.mocked(bridge)
    .mockResolvedValueOnce([main])
    .mockResolvedValueOnce([{ ...main, alive: false }])
    .mockResolvedValueOnce([main]);
  expect(await mainAppRunning(project)).toBe(true);
  expect(await mainAppRunning(project)).toBe(false);
  expect(await mainAppRunning(project)).toBe(true);
});

it('returns idle when the workspace bridge cannot verify activity', async () => {
  vi.mocked(bridge).mockRejectedValue(new Error('Workspace stopped'));
  expect(await mainAppRunning(project)).toBe(false);
});

it('returns idle when main process identities cannot be read', async () => {
  vi.mocked(mainRunProcessIds).mockRejectedValue(new Error('Unavailable'));
  expect(await mainAppRunning(project)).toBe(false);
  expect(bridge).not.toHaveBeenCalled();
});

it('requires explicit boolean liveness and Run identification', async () => {
  vi.mocked(bridge).mockResolvedValue([{ ...main, alive: 'true' }]);
  expect(await mainAppRunning(project)).toBe(false);
  vi.mocked(bridge).mockResolvedValue([{ ...main, isRun: 'true' }]);
  expect(await mainAppRunning(project)).toBe(false);
});
