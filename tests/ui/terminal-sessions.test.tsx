// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { act, renderHook, render, screen } from '@testing-library/react';
import { useTerminals } from '../../apps/web/src/workspace/useTerminals';
import { TerminalPanel } from '../../apps/web/src/workspace/TerminalPanel';
import { api, post } from '../../apps/web/src/api';
import { deferred } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
vi.mock('../../apps/web/src/Terminal', () => ({ Terminal: () => <div>Output</div> }));
const shell = { id: 'shell', name: 'Shell', alive: true, isRun: false };
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(post).mockReset();
});
it('closing the last terminal does not recreate it or resurrect it from an older poll', async () => {
  vi.mocked(api).mockResolvedValue([shell]);
  const { result } = renderHook(() =>
    useTerminals('/projects/project', 'shell', true, { current: true }),
  );
  await act(() => result.current.reload());
  const pending = deferred<(typeof shell)[]>();
  vi.mocked(api).mockReturnValueOnce(pending.promise);
  let loading!: Promise<void>;
  act(() => {
    loading = result.current.reload();
  });
  act(() => result.current.didClose('shell'));
  expect(result.current.terminals).toEqual([]);
  await act(async () => {
    pending.resolve([shell]);
    await loading;
  });
  expect(result.current.terminals).toEqual([]);
  expect(result.current.terminal).toBe('');
  expect(post).not.toHaveBeenCalled();
});
it('pins and distinguishes the main Run even when its process has a UUID session', () => {
  const main = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Run',
    alive: true,
    isRun: true,
    isMainRun: true,
  };
  const { container } = render(
    <TerminalPanel
      projectId="project"
      visible
      terminals={[shell, main]}
      terminal={main.id}
      error=""
      editable
      onSelect={vi.fn()}
      onStop={vi.fn()}
      onCreate={vi.fn()}
      onRetry={vi.fn()}
    />,
  );
  expect(container.querySelector('.terminal-tab')?.classList.contains('pinned')).toBe(true);
  expect(screen.getByTitle('Run output · Running')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Close Shell' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Close Run' })).toBeNull();
});
