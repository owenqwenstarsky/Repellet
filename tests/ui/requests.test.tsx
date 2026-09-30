// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QuickOpen } from '../../apps/web/src/QuickOpen';
import { SearchPane } from '../../apps/web/src/Files';
import { GitPane } from '../../apps/web/src/GitPane';
import { UiProvider } from '../../apps/web/src/ui';
import { api } from '../../apps/web/src/api';
import { deferred } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
vi.mock('../../apps/web/src/CodeDiff', () => ({
  CodeDiff: ({ modified }: any) => <div>{modified}</div>,
}));
beforeEach(() => vi.mocked(api).mockReset());
it('clamps Quick Open selection after index changes and clears a recovered error', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ paths: ['a', 'b', 'c'] })
    .mockRejectedValueOnce(new Error('Index offline'))
    .mockResolvedValueOnce({ paths: ['a'] });
  const onOpen = vi.fn(),
    onClose = vi.fn();
  const view = render(<QuickOpen projectId="p" revision={0} onOpen={onOpen} onClose={onClose} />);
  await screen.findByText('c');
  const input = screen.getByLabelText('Search file paths');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  view.rerender(<QuickOpen projectId="p" revision={1} onOpen={onOpen} onClose={onClose} />);
  await screen.findByRole('alert');
  view.rerender(<QuickOpen projectId="p" revision={2} onOpen={onOpen} onClose={onClose} />);
  await act(async () => {});
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onOpen).toHaveBeenCalledWith('a');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('ignores older search results and invalidates them when the query changes', async () => {
  const first = deferred<any>(),
    second = deferred<any>();
  vi.mocked(api).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  render(
    <UiProvider>
      <SearchPane projectId="p" editable onOpen={vi.fn()} />
    </UiProvider>,
  );
  const input = screen.getByLabelText('Find in project');
  fireEvent.change(input, { target: { value: 'first' } });
  fireEvent.submit(input.closest('form')!);
  fireEvent.change(input, { target: { value: 'second' } });
  fireEvent.submit(input.closest('form')!);
  await act(async () => second.resolve([{ path: 'new.ts', line: 1, text: 'New result' }]));
  await act(async () => first.resolve([{ path: 'old.ts', line: 1, text: 'Old result' }]));
  expect(screen.getByText('New result')).toBeTruthy();
  expect(screen.queryByText('Old result')).toBeNull();
});
const status = {
  initialized: true,
  branch: 'main',
  branches: ['main'],
  entries: [
    { path: 'one', index: ' ', worktree: 'M' },
    { path: 'two', index: ' ', worktree: 'M' },
  ],
  ahead: 0,
  behind: 0,
};
it('ignores older Git status responses and clears errors after retry', async () => {
  const first = deferred<any>();
  vi.mocked(api)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ ...status, branch: 'new', branches: ['new'] })
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(status);
  render(
    <UiProvider>
      <GitPane projectId="p" editable={false} revision={0} />
    </UiProvider>,
  );
  fireEvent.click(screen.getByLabelText('Refresh Git status'));
  await screen.findByText('new');
  await act(async () => first.resolve(status));
  expect(screen.getByText('new')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Refresh Git status'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByLabelText('Refresh Git status'));
  await screen.findByText('main');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('ignores older diffs and responses after dismissal', async () => {
  const first = deferred<any>(),
    second = deferred<any>(),
    third = deferred<any>();
  vi.mocked(api)
    .mockResolvedValueOnce(status)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  render(
    <UiProvider>
      <GitPane projectId="p" editable={false} revision={0} />
    </UiProvider>,
  );
  await screen.findByText('one');
  fireEvent.click(screen.getByText('one'));
  fireEvent.click(screen.getByText('two'));
  await act(async () => second.resolve({ original: '', modified: 'New diff' }));
  await screen.findByText('New diff');
  await act(async () => first.resolve({ original: '', modified: 'Old diff' }));
  expect(screen.getByRole('dialog').getAttribute('aria-label')).toContain('two');
  fireEvent.click(screen.getByText('one'));
  fireEvent.click(screen.getByLabelText('Close dialog'));
  await act(async () => third.resolve({ original: '', modified: 'Late diff' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
