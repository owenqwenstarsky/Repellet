// @vitest-environment jsdom
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { api, post, put, patch } from '../apps/web/src/api';
import { UiProvider } from '../apps/web/src/ui';
import { ProjectSettings } from '../apps/web/src/Settings';
import { SearchPane, FileTree } from '../apps/web/src/Files';
import { GitPane } from '../apps/web/src/GitPane';
import { Workspace } from '../apps/web/src/Workspace';
import { Projects } from '../apps/web/src/Projects';
import App from '../apps/web/src/App';
import { Admin } from '../apps/web/src/Admin';
import { user, project, deferred, FakeSocket } from './web-support';
vi.mock('../apps/web/src/api', async (original) => ({
  ...(await original<typeof import('../apps/web/src/api')>()),
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
}));
vi.mock('../apps/web/src/Terminal', () => ({ Terminal: () => <div>Terminal content</div> }));
vi.mock('../apps/web/src/CodeEditor', () => ({
  CodeEditor: ({ path }: { path: string }) => <div>Editing {path}</div>,
}));
const mockedApi = vi.mocked(api),
  mockedPost = vi.mocked(post);
async function flush() {
  await act(async () => {});
}
function baseApi(path: string): any {
  if (path === '/projects/project') return Promise.resolve(project);
  if (path.endsWith('/environment')) return Promise.resolve({ variables: {} });
  if (path.endsWith('/git/status'))
    return Promise.resolve({
      initialized: true,
      branches: ['main'],
      upstream: null,
      ahead: 0,
      behind: 0,
      branch: 'main',
      entries: [],
    });
  if (path.includes('/file?')) return Promise.resolve({ binary: false });
  return Promise.resolve([]);
}
beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  mockedApi.mockImplementation(baseApi);
  mockedPost.mockResolvedValue({});
  vi.mocked(put).mockResolvedValue({});
  vi.mocked(patch).mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function settings() {
  return render(
    <UiProvider>
      <ProjectSettings
        project={project}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        onDuplicate={vi.fn()}
      />
    </UiProvider>,
  );
}
describe('environment snapshots and validation', () => {
  it('disables editing and saving until loading succeeds, and retries failed loads', async () => {
    const initial = deferred<any>();
    mockedApi.mockImplementation((path) =>
      path.endsWith('/environment') ? initial.promise : baseApi(path),
    );
    settings();
    fireEvent.click(screen.getByText('Environment'));
    expect((screen.getByText('Add variable').closest('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Save changes' }).closest('button') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => initial.reject(new Error('Snapshot failed')));
    expect(screen.getByRole('alert').textContent).toContain('Snapshot failed');
    mockedApi.mockImplementation((path) =>
      path.endsWith('/environment')
        ? Promise.resolve({ variables: { EXISTING: 'value' } })
        : baseApi(path),
    );
    fireEvent.click(screen.getByText('Retry environment'));
    await flush();
    expect((screen.getByLabelText('Variable name 1') as HTMLInputElement).value).toBe('EXISTING');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(put).toHaveBeenCalledWith('/projects/project/environment', {
      runtimes: ['node'],
      variables: { EXISTING: 'value' },
    });
  });
  it('validates reserved variable names and port constraints before making a request', async () => {
    settings();
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Run', exact: true }));
    fireEvent.change(screen.getByLabelText('Preview port'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Environment'));
    fireEvent.click(screen.getByText('Add variable'));
    fireEvent.change(screen.getByLabelText('Variable name 1'), { target: { value: 'PATH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(screen.getByText('Reserved variable')).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
  });
  it('does not navigate when duplication completes after dismissal', async () => {
    const result = deferred<any>(),
      onDuplicate = vi.fn(),
      onClose = vi.fn();
    mockedPost.mockReturnValue(result.promise);
    render(
      <UiProvider>
        <ProjectSettings
          project={project}
          onClose={onClose}
          onChanged={vi.fn()}
          onDuplicate={onDuplicate}
        />
      </UiProvider>,
    );
    await flush();
    fireEvent.click(screen.getByText('Duplicate'));
    fireEvent.click(screen.getByLabelText('Close dialog'));
    await act(async () => result.resolve({ id: 'copy' }));
    expect(onClose).toHaveBeenCalled();
    expect(onDuplicate).not.toHaveBeenCalled();
  });
});
describe('search request ownership', () => {
  it('clears outdated query results and ignores late responses', async () => {
    const old = deferred<any>(),
      recent = deferred<any>();
    mockedApi.mockImplementation((path) =>
      path.includes('query=old') ? old.promise : recent.promise,
    );
    render(
      <UiProvider>
        <SearchPane projectId="project" editable onOpen={vi.fn()} />
      </UiProvider>,
    );
    const input = screen.getByLabelText('Find in project');
    fireEvent.change(input, { target: { value: 'old' } });
    fireEvent.click(screen.getByText('Search', { selector: 'button' }));
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.click(screen.getByText('Search', { selector: 'button' }));
    await act(async () => recent.resolve([{ path: 'new.ts', line: 1, text: 'new' }]));
    await act(async () => old.resolve([{ path: 'old.ts', line: 1, text: 'old' }]));
    expect(screen.getByText('new.ts:1')).toBeTruthy();
    expect(screen.queryByText('old.ts:1')).toBeNull();
    fireEvent.change(input, { target: { value: 'different' } });
    expect(screen.queryByText('new.ts:1')).toBeNull();
  });
  it('keeps replacement busy through its follow-up search and captures submitted values', async () => {
    const replace = deferred<any>(),
      refresh = deferred<any>();
    mockedPost.mockReturnValue(replace.promise);
    mockedApi.mockReturnValue(refresh.promise);
    render(
      <UiProvider>
        <SearchPane projectId="project" editable onOpen={vi.fn()} />
      </UiProvider>,
    );
    fireEvent.change(screen.getByLabelText('Find in project'), { target: { value: 'old' } });
    fireEvent.change(screen.getByLabelText('Replacement'), { target: { value: 'replacement' } });
    fireEvent.click(screen.getByText('Replace all'));
    fireEvent.click(screen.getByText('Confirm'));
    await flush();
    expect(post).toHaveBeenCalledWith('/projects/project/replace', {
      query: 'old',
      replacement: 'replacement',
    });
    await act(async () => replace.resolve({ files: 2 }));
    expect((screen.getByText('Replace all').closest('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => refresh.resolve([]));
    expect((screen.getByText('Replace all').closest('button') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});
describe('explorer recovery and remapping', () => {
  it('shows a failed load with Retry instead of an empty tree', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Listing failed'));
    render(
      <UiProvider>
        <FileTree projectId="project" active="" editable revision={0} onOpen={vi.fn()} />
      </UiProvider>,
    );
    await flush();
    expect(screen.getByText('Listing failed')).toBeTruthy();
    expect(screen.queryByText('No files yet.')).toBeNull();
    fireEvent.click(screen.getByText('Retry'));
    await flush();
    expect(screen.getByText('No files yet.')).toBeTruthy();
  });
  it('remaps expanded and selected directories before requesting their new paths', async () => {
    let renamed = false;
    mockedApi.mockImplementation((path) =>
      Promise.resolve(
        path.endsWith('path=')
          ? [{ name: renamed ? 'lib' : 'src', path: renamed ? 'lib' : 'src', kind: 'directory' }]
          : [],
      ),
    );
    const props = {
      projectId: 'project',
      active: '',
      editable: true,
      revision: 0,
      onOpen: vi.fn(),
    };
    const view = render(
      <UiProvider>
        <FileTree {...props} />
      </UiProvider>,
    );
    await flush();
    fireEvent.click(screen.getByText('src'));
    await flush();
    mockedApi.mockClear();
    renamed = true;
    view.rerender(
      <UiProvider>
        <FileTree {...props} revision={1} structure={{ from: 'src', to: 'lib' }} />
      </UiProvider>,
    );
    await flush();
    expect(mockedApi.mock.calls.some(([p]) => p.endsWith('path=lib'))).toBe(true);
    expect(mockedApi.mock.calls.some(([p]) => p.endsWith('path=src'))).toBe(false);
    fireEvent.click(screen.getByLabelText('New file'));
    expect((screen.getByLabelText('Workspace path') as HTMLInputElement).value).toBe('lib/');
  });
});
describe('Git states', () => {
  it('renders both mixed-file actions, accurate deletion badges, and disables Commit during conflicts', async () => {
    mockedApi.mockResolvedValue({
      initialized: true,
      branches: ['main'],
      upstream: null,
      ahead: 0,
      behind: 0,
      branch: 'long/branch',
      entries: [
        { path: 'mixed.ts', index: 'M', worktree: 'M' },
        { path: 'gone.ts', index: ' ', worktree: 'D' },
        { path: 'conflict.ts', index: 'U', worktree: 'U' },
      ],
    });
    render(
      <UiProvider>
        <GitPane projectId="project" editable revision={0} />
      </UiProvider>,
    );
    await flush();
    expect(screen.getByLabelText('Stage mixed.ts')).toBeTruthy();
    expect(screen.getByLabelText('Unstage mixed.ts')).toBeTruthy();
    expect(screen.getByText('D')).toBeTruthy();
    expect(screen.getByText('UU')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'commit' } });
    expect(
      (screen.getByText('Commit staged changes').closest('button') as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
function workspace() {
  return render(
    <UiProvider>
      <Workspace id="project" user={user} onBack={vi.fn()} onOpen={vi.fn()} />
    </UiProvider>,
  );
}
describe('workspace state recovery', () => {
  it('retains the loaded IDE on poll failures and clears the recovered error', async () => {
    vi.useFakeTimers();
    workspace();
    await flush();
    mockedApi.mockImplementation((path) =>
      path === '/projects/project' ? Promise.reject(new Error('Transient poll')) : baseApi(path),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByLabelText('Workspace tools')).toBeTruthy();
    expect(screen.getByText('Workspace update failed: Transient poll')).toBeTruthy();
    mockedApi.mockImplementation(baseApi);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByText('Workspace update failed: Transient poll')).toBeNull();
  });
  it('preserves Git drafts and search queries while tools are hidden', async () => {
    workspace();
    await flush();
    fireEvent.click(screen.getByLabelText('Source control'));
    await flush();
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByLabelText('Search'));
    await flush();
    fireEvent.change(screen.getByLabelText('Find in project'), { target: { value: 'query' } });
    fireEvent.click(screen.getByLabelText('Files'));
    fireEvent.click(screen.getByLabelText('Source control'));
    expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe('draft');
    fireEvent.click(screen.getByLabelText('Search'));
    expect((screen.getByLabelText('Find in project') as HTMLInputElement).value).toBe('query');
  });
  it('does not activate superseded file-open responses and picks a remaining tab after deletion', async () => {
    const old = deferred<any>(),
      recent = deferred<any>();
    mockedApi.mockImplementation((path) =>
      path.includes('/files?')
        ? Promise.resolve(['a.ts', 'b.ts'].map((name) => ({ name, path: name, kind: 'file' })))
        : path.includes('path=a.ts')
          ? old.promise
          : path.includes('path=b.ts')
            ? recent.promise
            : baseApi(path),
    );
    workspace();
    await flush();
    fireEvent.click(screen.getByText('a.ts'));
    fireEvent.click(screen.getByText('b.ts'));
    await act(async () => recent.resolve({ binary: false }));
    await waitFor(() => screen.getByText('Editing b.ts'));
    await act(async () => old.resolve({ binary: false }));
    expect(screen.queryByText('Editing a.ts')).toBeNull();
    fireEvent.click(screen.getByText('a.ts'));
    await flush();
    await waitFor(() => screen.getByText('Editing a.ts'));
    const events = FakeSocket.instances.find((s) => new URL(s.url).pathname.endsWith('/events'))!;
    await act(async () => events.message({ type: 'structure', from: 'a.ts' }));
    expect(screen.getByText('Editing b.ts')).toBeTruthy();
  });
  it('guards Run shortcuts during a pending run and dialogs', async () => {
    const run = deferred<any>();
    mockedPost.mockImplementation((path) =>
      path.endsWith('/run') ? run.promise : Promise.resolve({}),
    );
    workspace();
    await flush();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(mockedPost.mock.calls.filter(([p]) => p.endsWith('/run'))).toHaveLength(1);
    await act(async () => run.resolve({}));
    fireEvent.click(screen.getByLabelText('Project settings'));
    await flush();
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(mockedPost.mock.calls.filter(([p]) => p.endsWith('/run'))).toHaveLength(1);
  });
  it('retries automatic terminal creation after a failed attempt', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    mockedPost.mockImplementation((path) =>
      path.endsWith('/terminals')
        ? ++attempts === 1
          ? Promise.reject(new Error('Terminal failed'))
          : Promise.resolve({ id: 'shell', name: 'Shell', alive: true, isRun: false })
        : Promise.resolve({}),
    );
    workspace();
    await flush();
    fireEvent.click(screen.getByLabelText('Toggle bottom panel'));
    expect(screen.getByText('Terminal failed')).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(attempts).toBe(2);
    expect(screen.queryByText('Terminal failed')).toBeNull();
  });
});
describe('create dialog cancellation', () => {
  it('ignores a late create result after the dialog is dismissed', async () => {
    const result = deferred<any>(),
      onOpen = vi.fn();
    mockedPost.mockReturnValue(result.promise);
    render(
      <UiProvider>
        <Projects user={user} onOpen={onOpen} />
      </UiProvider>,
    );
    await flush();
    fireEvent.click(screen.getByText('Create project'));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New' } });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    fireEvent.click(screen.getByText('Cancel'));
    await act(async () => result.resolve(project));
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('loading recovery and keyboard feedback', () => {
  it('recovers an initial workspace load failure with Retry', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Project unavailable'));
    workspace();
    await flush();
    expect(screen.getByText('Workspace unavailable')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    await flush();
    expect(screen.getByLabelText('Workspace tools')).toBeTruthy();
  });
  it('keeps build-log failure separate from workspace availability', async () => {
    mockedApi.mockImplementation((path) =>
      path === '/projects/project'
        ? Promise.resolve({ ...project, state: 'starting' })
        : path.endsWith('/build-log')
          ? Promise.reject(new Error('Log missing'))
          : baseApi(path),
    );
    workspace();
    await flush();
    expect(screen.getByText('Preparing your environment')).toBeTruthy();
    expect(screen.getByText('Build log unavailable: Log missing')).toBeTruthy();
    expect(screen.queryByText('Workspace unavailable')).toBeNull();
  });
  it('shows a project-list load error and allows retry', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Project list failed'));
    render(
      <UiProvider>
        <Projects user={user} onOpen={vi.fn()} />
      </UiProvider>,
    );
    await flush();
    expect(screen.getByText('Project list failed')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    fireEvent.click(screen.getByText('Retry'));
    await flush();
    expect(screen.getByText('Room for your next idea')).toBeTruthy();
  });
  it('dismisses rebuild confirmation without closing settings and restores the save trigger', async () => {
    settings();
    await flush();
    fireEvent.click(screen.getByText('Environment'));
    fireEvent.click(screen.getByText('Python'));
    const save = screen.getByRole('button', { name: 'Save changes' }).closest('button')!;
    save.focus();
    fireEvent.click(save);
    await flush();
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    await flush();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Project settings' })).toBeTruthy();
    expect(document.activeElement).toBe(save);
  });
});

describe('pane loading feedback and deferred mutations', () => {
  it('retries Git status and People requests after failure', async () => {
    mockedApi.mockImplementation((path) =>
      path.endsWith('/git/status') || path.endsWith('/members')
        ? Promise.reject(new Error('Service unavailable'))
        : baseApi(path),
    );
    const view = render(
      <UiProvider>
        <GitPane projectId="project" editable revision={0} />
      </UiProvider>,
    );
    await flush();
    expect(screen.getByText('Service unavailable')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    mockedApi.mockImplementation(baseApi);
    fireEvent.click(screen.getByText('Retry'));
    await flush();
    expect(screen.getByText('Working tree is clean.')).toBeTruthy();
    view.unmount();
    mockedApi.mockImplementation((path) =>
      path.endsWith('/members') ? Promise.reject(new Error('People failed')) : baseApi(path),
    );
    settings();
    await flush();
    fireEvent.click(screen.getByText('People'));
    expect(screen.getByText('People failed')).toBeTruthy();
    mockedApi.mockImplementation(baseApi);
    fireEvent.click(screen.getByText('Retry'));
    await flush();
    expect(screen.queryByText('People failed')).toBeNull();
  });
  it('keeps Git stage-all and branch controls disabled while a mutation is pending', async () => {
    const mutation = deferred<any>();
    mockedPost.mockReturnValue(mutation.promise);
    mockedApi.mockResolvedValue({
      initialized: true,
      branches: ['main'],
      upstream: null,
      ahead: 0,
      behind: 0,
      branch: 'main',
      entries: [{ path: 'file.ts', index: ' ', worktree: 'M' }],
    });
    render(
      <UiProvider>
        <GitPane projectId="project" editable revision={0} />
      </UiProvider>,
    );
    await flush();
    fireEvent.click(screen.getByLabelText('Stage file.ts'));
    expect((screen.getByLabelText('Current branch') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Create branch') as HTMLButtonElement).disabled).toBe(true);
    const all = screen.getByLabelText(
      'Stage all unstaged / untracked changes',
    ) as HTMLButtonElement;
    expect(all.disabled).toBe(true);
    fireEvent.click(all);
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => mutation.resolve({}));
  });
  it('uses native sibling buttons for terminal selection and stopping, with fixed toolbar actions', async () => {
    mockedApi.mockImplementation((path) =>
      path.endsWith('/terminals')
        ? Promise.resolve([{ id: 'shell', name: 'Shell', alive: true, isRun: false }])
        : baseApi(path),
    );
    workspace();
    await flush();
    fireEvent.click(screen.getByLabelText('Toggle bottom panel'));
    const stop = screen.getByRole('button', { name: 'Close Shell' });
    expect(stop.parentElement?.tagName).toBe('DIV');
    expect(stop.closest('.terminal-tab')).toBeTruthy();
    expect(screen.getByLabelText('New terminal').closest('.terminal-tabs')).toBeNull();
    expect(screen.getByLabelText('Hide bottom panel').closest('.terminal-tabs')).toBeNull();
  });
  it('remaps consecutive structure events even when React batches them', async () => {
    const props = {
      projectId: 'project',
      active: '',
      editable: true,
      revision: 0,
      onOpen: vi.fn(),
    };
    let moved = false;
    mockedApi.mockImplementation((path) =>
      Promise.resolve(
        path.endsWith('path=')
          ? [{ name: moved ? 'final' : 'src', path: moved ? 'final' : 'src', kind: 'directory' }]
          : [],
      ),
    );
    const view = render(
      <UiProvider>
        <FileTree {...props} />
      </UiProvider>,
    );
    await flush();
    fireEvent.click(screen.getByText('src'));
    await flush();
    mockedApi.mockClear();
    moved = true;
    view.rerender(
      <UiProvider>
        <FileTree
          {...props}
          revision={2}
          structure={[
            { from: 'src', to: 'lib' },
            { from: 'lib', to: 'final' },
          ]}
        />
      </UiProvider>,
    );
    await flush();
    expect(mockedApi.mock.calls.some(([p]) => p.endsWith('path=final'))).toBe(true);
    expect(
      mockedApi.mock.calls.some(([p]) => p.endsWith('path=src') || p.endsWith('path=lib')),
    ).toBe(false);
  });
});

describe('account mutations and health freshness', () => {
  function applicationApi(path: string): any {
    if (path === '/setup/status') return Promise.resolve({ required: false });
    if (path === '/auth/me') return Promise.resolve({ user });
    if (path === '/health') return Promise.resolve({ worker: true });
    return baseApi(path);
  }
  it('refreshes server health periodically and shows a failed health request as unavailable', async () => {
    vi.useFakeTimers();
    history.replaceState(null, '', '/');
    mockedApi.mockImplementation(applicationApi);
    render(<App />);
    await flush();
    expect(screen.getByText('Server connected')).toBeTruthy();
    mockedApi.mockImplementation((path) =>
      path === '/health' ? Promise.reject(new Error('Offline')) : applicationApi(path),
    );
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(screen.getByText('Container worker unavailable')).toBeTruthy();
    mockedApi.mockImplementation(applicationApi);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(screen.getByText('Server connected')).toBeTruthy();
  });
  it('guards password submission and leaves a newer dialog open when an obsolete request completes', async () => {
    history.replaceState(null, '', '/');
    mockedApi.mockImplementation(applicationApi);
    const result = deferred<any>();
    mockedPost.mockReturnValue(result.promise);
    render(<App />);
    await flush();
    fireEvent.click(screen.getByLabelText('Account for Owen'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change password' }));
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current-password' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'new-password-12345' },
    });
    const form = screen.getByRole('dialog').querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByLabelText('Account for Owen'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change password' }));
    await act(async () => result.resolve({ user }));
    expect(screen.getByRole('dialog', { name: 'Change password' })).toBeTruthy();
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('');
  });
});

it('allows create and password completion after Strict Mode effect replay', async () => {
  const onOpen = vi.fn();
  mockedPost.mockResolvedValue(project);
  const view = render(
    <StrictMode>
      <UiProvider>
        <Projects user={user} onOpen={onOpen} />
      </UiProvider>
    </StrictMode>,
  );
  await flush();
  fireEvent.click(screen.getByText('Create project'));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Created' } });
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await flush();
  expect(onOpen).toHaveBeenCalledWith('project');
  view.unmount();
  mockedApi.mockImplementation((path) =>
    path === '/setup/status'
      ? Promise.resolve({ required: false })
      : path === '/auth/me'
        ? Promise.resolve({ user })
        : path === '/health'
          ? Promise.resolve({ worker: true })
          : baseApi(path),
  );
  mockedPost.mockResolvedValue({ user });
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await flush();
  const account = screen.getByLabelText('Account for Owen');
  account.focus();
  fireEvent.click(account);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Change password' }));
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: 'current-password' },
  });
  fireEvent.change(screen.getByLabelText('New password'), {
    target: { value: 'new-password-12345' },
  });
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  await flush();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(account);
});

describe('field-level shared form validation', () => {
  it('rejects a whitespace-only project name before sending the create request', async () => {
    render(
      <UiProvider>
        <Projects user={user} onOpen={vi.fn()} />
      </UiProvider>,
    );
    await flush();
    fireEvent.click(screen.getByText('Create project'));
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: '   ' } });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(document.getElementById('create-name-error')).toBeTruthy();
    expect(screen.getByText('Check the highlighted fields.')).toBeTruthy();
  });
  it('validates administration fields locally and exposes failed administration loads with Retry', async () => {
    mockedApi.mockRejectedValueOnce(new Error('Administration failed'));
    render(
      <UiProvider>
        <Admin onOpen={vi.fn()} />
      </UiProvider>,
    );
    await flush();
    expect(screen.getByText('Administration failed')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    await flush();
    expect(screen.queryByText('Administration failed')).toBeNull();
    fireEvent.click(screen.getByText('Add person'));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'test-person' } });
    fireEvent.change(screen.getByLabelText('Initial password'), {
      target: { value: 'password-for-tests-123' },
    });
    fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(document.getElementById('person-displayName-error')).toBeTruthy();
  });
});

it('resizes from effective panel dimensions when requested sizes are constrained', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  const view = workspace();
  await flush();
  const explorer = view.container.querySelector('.explorer') as HTMLElement;
  expect(explorer.style.width).toBe('205px');
  fireEvent.keyDown(screen.getAllByRole('separator', { name: 'Resize panel' })[0], {
    key: 'ArrowLeft',
  });
  expect(explorer.style.width).toBe('195px');
  fireEvent.click(screen.getByLabelText('Toggle bottom panel'));
  const resize = screen.getByRole('separator', { name: 'Resize bottom panel' });
  for (let i = 0; i < 20; i++) fireEvent.keyDown(resize, { key: 'ArrowUp' });
  const terminal = view.container.querySelector('.workspace-bottom-panel') as HTMLElement;
  expect(terminal.style.height).toBe('335px');
  fireEvent.keyDown(resize, { key: 'ArrowDown' });
  expect(terminal.style.height).toBe('325px');
});

describe('run settings drafts', () => {
  it('keeps every unsaved run field when switching tabs and receiving server updates', async () => {
    const view = settings();
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    for (const [label, value] of [
      ['Run command', 'node custom.mjs'],
      ['Project folder', 'src'],
      ['Preview port', '4000'],
      ['Install command (optional)', 'npm install'],
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('tab', { name: 'General' }));
    view.rerender(
      <UiProvider>
        <ProjectSettings
          project={{ ...project, description: 'Updated by another editor' }}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onDuplicate={vi.fn()}
        />
      </UiProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    for (const [label, value] of [
      ['Run command', 'node custom.mjs'],
      ['Project folder', 'src'],
      ['Preview port', '4000'],
      ['Install command (optional)', 'npm install'],
    ]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await flush();
    expect(patch).toHaveBeenCalledWith('/projects/project', {
      runConfig: { command: 'node custom.mjs', cwd: 'src', port: 4000 },
      setupCommand: 'npm install',
    });
  });
  it('disables tab switching during a pending run settings save', async () => {
    const pending = deferred<any>();
    vi.mocked(patch).mockReturnValueOnce(pending.promise);
    settings();
    await flush();
    fireEvent.click(screen.getByRole('tab', { name: 'Run' }));
    fireEvent.change(screen.getByLabelText('Run command'), { target: { value: 'npm start' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((screen.getByRole('tab', { name: 'General' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve({}));
    expect((screen.getByRole('tab', { name: 'General' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

it.each(['a.ts', 'src'])(
  'does not reopen a deleted %s from a delayed file response',
  async (removed) => {
    const pending = deferred<any>();
    const path = removed === 'src' ? 'src/a.ts' : 'a.ts';
    mockedApi.mockImplementation((url) =>
      url.includes('/files?')
        ? Promise.resolve([path, 'b.ts'].map((name) => ({ name, path: name, kind: 'file' })))
        : url.includes('path=' + encodeURIComponent(path))
          ? pending.promise
          : baseApi(url),
    );
    workspace();
    await flush();
    fireEvent.click(screen.getByText('b.ts'));
    await screen.findByText('Editing b.ts');
    fireEvent.click(screen.getByText(path));
    const events = FakeSocket.instances.find((s) => new URL(s.url).pathname.endsWith('/events'))!;
    await act(async () =>
      events.message({
        type: 'file',
        event: removed === 'src' ? 'unlinkDir' : 'unlink',
        path: removed,
      }),
    );
    await act(async () => pending.resolve({ binary: false, hash: 'hash' }));
    expect(screen.queryByText('Editing ' + path)).toBeNull();
    expect(screen.getByText('Editing b.ts')).toBeTruthy();
  },
);
