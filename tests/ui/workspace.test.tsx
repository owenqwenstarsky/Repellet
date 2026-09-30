// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Workspace } from '../../apps/web/src/Workspace';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post } from '../../apps/web/src/api';
import { flushOpenDocuments } from '../../apps/web/src/documentSaves';
import { preferenceKey } from '../../apps/web/src/preferences';
import { deferred, project, user } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  errorMessage: (e: Error) => e.message,
  wsUrl: (s: string) => s,
  previewUrl: () => '',
  formatBytes: () => '0 B',
}));
vi.mock('../../apps/web/src/CodeEditor', () => ({
  CodeEditor: ({ path, active }: any) => (
    <textarea aria-label={`Editor ${path}`} data-active={active} />
  ),
}));
vi.mock('../../apps/web/src/Terminal', () => ({ Terminal: () => <div>Terminal rendering</div> }));
vi.mock('../../apps/web/src/documentSaves', () => ({ flushOpenDocuments: vi.fn() }));
const terminals = [{ id: 'shell', name: 'Shell', alive: true, isRun: false }];
function defaults(p = project) {
  vi.mocked(api).mockImplementation(async (path) =>
    path === '/projects/project'
      ? p
      : path.endsWith('/terminals')
        ? terminals
        : path.includes('/files?')
          ? ['a.ts', 'b.ts', 'c.ts'].map((name) => ({ path: name, name, kind: 'file' }))
          : path.includes('/file?')
            ? { hash: 'hash', content: '', binary: false }
            : path.endsWith('/file-index')
              ? { paths: [] }
              : path.endsWith('/preparation')
                ? { jobs: [] }
                : path.endsWith('/build-log')
                  ? { log: '' }
                  : [],
  );
}
beforeEach(() => {
  vi.mocked(api).mockReset();
  defaults();
  vi.mocked(post).mockReset().mockResolvedValue({});
  vi.mocked(flushOpenDocuments).mockReset().mockResolvedValue();
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  );
});
function mount() {
  return render(
    <UiProvider>
      <Workspace id="project" user={user} onBack={vi.fn()} onOpen={vi.fn()} />
    </UiProvider>,
  );
}
for (const [name, changes] of [
  ['not running', { state: 'building' }],
  ['over storage limit', { storageExceeded: true }],
  ['preparing', { preparation: { status: 'installing', error: null } }],
  ['viewer', { role: 'viewer' }],
] as const)
  it(`guards Run keyboard shortcut when ${name}`, async () => {
    defaults({ ...project, ...changes } as typeof project);
    mount();
    await screen.findByLabelText('Project settings');
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await act(async () => {});
    expect(post).not.toHaveBeenCalledWith('/projects/project/run');
    expect(flushOpenDocuments).not.toHaveBeenCalled();
  });
it('guards Run before the project is loaded', async () => {
  vi.mocked(api).mockReturnValue(new Promise(() => {}));
  mount();
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(flushOpenDocuments).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('shares in-flight guards between Run button and shortcut, and permits retry after failure', async () => {
  const pending = deferred<void>();
  vi.mocked(flushOpenDocuments).mockReturnValueOnce(pending.promise);
  mount();
  await screen.findByRole('button', { name: 'Run' });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(flushOpenDocuments).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new Error('Save failed')));
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/project/run'));
});
it('suppresses workspace shortcuts behind dialogs and reveals the sidebar for Find', async () => {
  mount();
  await screen.findByLabelText('Toggle sidebar');
  fireEvent.click(screen.getByLabelText('Toggle sidebar'));
  fireEvent.keyDown(window, { key: 'F', ctrlKey: true, shiftKey: true });
  expect(screen.getByLabelText('Find in project')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Project settings'));
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(flushOpenDocuments).not.toHaveBeenCalled();
});
it('keeps editors mounted during polling failures and clears the error after recovery', async () => {
  vi.useFakeTimers();
  mount();
  await act(async () => {});
  fireEvent.click(screen.getByText('a.ts'));
  await act(async () => {});
  const editor = screen.getByLabelText('Editor a.ts');
  vi.mocked(api).mockRejectedValueOnce(new Error('Offline'));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByLabelText('Editor a.ts')).toBe(editor);
  expect(screen.getByRole('alert').textContent).toContain('Offline');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('Editor a.ts')).toBe(editor);
});
it('offers retry and recovers from an initial load failure', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('Offline'));
  mount();
  await screen.findByText('Workspace unavailable');
  fireEvent.click(screen.getByText('Retry'));
  await screen.findByLabelText('Project settings');
  expect(screen.queryByText('Workspace unavailable')).toBeNull();
});
it('does not let delayed saved-tab restoration replace a user selection', async () => {
  const pending = deferred<any>();
  localStorage.setItem(
    preferenceKey(user.id, project.id),
    JSON.stringify({ version: 1, tabs: ['saved.ts'], active: 'saved.ts' }),
  );
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path) =>
    path.includes('path=saved.ts') ? pending.promise : original(path),
  );
  mount();
  await screen.findByText('a.ts');
  fireEvent.click(screen.getByText('a.ts'));
  await screen.findByLabelText('Editor a.ts');
  await act(async () => pending.resolve({ hash: 'hash', content: '' }));
  expect(screen.getByLabelText('Editor a.ts').getAttribute('data-active')).toBe('true');
  expect(screen.queryByLabelText('Editor saved.ts')).toBeNull();
});
it('does not let tab-close save replace a newer selected tab', async () => {
  mount();
  await screen.findByText('a.ts');
  for (const path of ['a.ts', 'b.ts', 'c.ts']) {
    fireEvent.click(screen.getAllByText(path)[0]);
    await screen.findByLabelText(`Editor ${path}`);
  }
  fireEvent.click(screen.getAllByText('a.ts')[1]);
  const pending = deferred<void>();
  vi.mocked(flushOpenDocuments).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByLabelText('Close a.ts'));
  fireEvent.click(screen.getAllByText('b.ts')[1]);
  await act(async () => pending.resolve());
  expect(screen.getByLabelText('Editor b.ts').getAttribute('data-active')).toBe('true');
});
it('makes terminal stop independently keyboard accessible', async () => {
  mount();
  const stop = await screen.findByRole('button', { name: 'Stop Shell' });
  expect(stop.tagName).toBe('BUTTON');
  expect(stop.parentElement?.tagName).not.toBe('BUTTON');
  const keyboard = userEvent.setup();
  stop.focus();
  await keyboard.keyboard('{Enter}');
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith('/projects/project/terminals/shell', { method: 'DELETE' }),
  );
});
it('rechecks run permissions after waiting for document saves', async () => {
  vi.useFakeTimers();
  const pending = deferred<void>();
  vi.mocked(flushOpenDocuments).mockReturnValueOnce(pending.promise);
  mount();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  defaults({ ...project, role: 'viewer' });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  await act(async () => pending.resolve());
  expect(post).not.toHaveBeenCalledWith('/projects/project/run');
});
it('never lets a slower file open replace a newer file selection', async () => {
  const pending = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path) =>
    path.includes('path=a.ts') ? pending.promise : original(path),
  );
  mount();
  await screen.findByText('a.ts');
  fireEvent.click(screen.getByText('a.ts'));
  fireEvent.click(screen.getByText('b.ts'));
  await screen.findByLabelText('Editor b.ts');
  await act(async () => pending.resolve({ hash: 'hash', content: '' }));
  expect(screen.getByLabelText('Editor b.ts').getAttribute('data-active')).toBe('true');
});
it('uses settings for a missing owner run command, and explains it to an editor', async () => {
  defaults({ ...project, runConfig: { ...project.runConfig, command: '' } });
  const view = mount();
  await screen.findByRole('button', { name: 'Run' });
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(screen.getByRole('dialog')).toBeTruthy();
  view.unmount();
  defaults({ ...project, role: 'editor', runConfig: { ...project.runConfig, command: '' } });
  mount();
  await screen.findByRole('button', { name: 'Run' });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(screen.getByText('The project owner needs to set a run command.')).toBeTruthy();
  expect(post).not.toHaveBeenCalledWith('/projects/project/run');
});
