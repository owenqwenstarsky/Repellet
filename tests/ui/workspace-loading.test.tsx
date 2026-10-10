// @vitest-environment jsdom
import { useEffect } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Workspace } from '../../apps/web/src/Workspace';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post } from '../../apps/web/src/api';
import { preferenceKey } from '../../apps/web/src/preferences';
import { deferred, project, user } from './helpers';

const { editors } = vi.hoisted(() => ({
  editors: new Map<string, (error?: string) => void>(),
}));
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  errorMessage: (e: Error) => e.message,
  wsUrl: (path: string) => path,
  previewUrl: () => 'https://preview.test',
  formatBytes: () => '0 B',
}));
vi.mock('../../apps/web/src/CodeEditor', () => ({
  CodeEditor: ({ path, initialLoadAttempt, onInitialLoad }: any) => {
    useEffect(() => {
      editors.set(path, onInitialLoad);
      return () => {
        editors.delete(path);
      };
    }, [path, initialLoadAttempt]);
    return <textarea aria-label={`Editor ${path}`} />;
  },
}));
vi.mock('../../apps/web/src/Terminal', () => ({ Terminal: () => null }));
const shell = { id: 'shell', name: 'Shell', alive: true, isRun: false };
const file = { hash: 'hash', content: 'const loaded = true;', binary: false };
function defaults(p = project) {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/projects/project') return p;
    if (path.includes('/files?')) return [{ name: 'a.ts', path: 'a.ts', kind: 'file' }];
    if (path.includes('/file?')) return file;
    if (path.endsWith('/terminals')) return [shell];
    if (path.endsWith('/preparation')) return { jobs: [] };
    if (path.endsWith('/build-log')) return { log: '' };
    return [];
  });
}
function save(tabs = ['a.ts'], active = tabs[0] || '', extra = {}) {
  localStorage.setItem(
    preferenceKey(user.id, project.id),
    JSON.stringify({ version: 1, tabs, active, ...extra }),
  );
}
function mount(onBack = vi.fn(), id = project.id) {
  return render(
    <UiProvider>
      <Workspace key={id} id={id} user={user} onBack={onBack} onOpen={vi.fn()} />
    </UiProvider>,
  );
}
const loading = () => screen.queryByRole('main', { name: 'Opening project' });
async function sync(path = 'a.ts') {
  await waitFor(() => expect(editors.has(path)).toBe(true));
  act(() => editors.get(path)!());
}
beforeEach(() => {
  editors.clear();
  vi.mocked(api).mockReset();
  defaults();
  vi.mocked(post).mockReset().mockResolvedValue({});
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  );
});

it('waits for project details, files, terminals, selection and synchronized text, with shortcuts disabled', async () => {
  save();
  const details = deferred<any>(),
    files = deferred<any>(),
    terminals = deferred<any>(),
    selection = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) => {
    if (path === '/projects/project') return details.promise;
    if (path.includes('/files?')) return files.promise;
    if (path.endsWith('/terminals')) return terminals.promise;
    if (path.includes('/file?')) return selection.promise;
    return original(path, options);
  });
  const onBack = vi.fn();
  const view = mount(onBack);
  expect(screen.getByRole('status').textContent).toContain('Loading project details');
  await act(async () => details.resolve(project));
  expect(loading()).toBeTruthy();
  const workspace = view.container.querySelector('.workspace')!;
  expect(workspace.getAttribute('aria-hidden')).toBe('true');
  expect(workspace.hasAttribute('inert')).toBe(true);
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
  fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(post).not.toHaveBeenCalledWith('/projects/project/run');
  await act(async () => files.resolve([]));
  expect(screen.getByRole('status').textContent).toContain('Loading terminal sessions');
  await act(async () => terminals.resolve([shell]));
  expect(screen.getByRole('status').textContent).toContain('Restoring your selected file');
  await act(async () => selection.resolve(file));
  await waitFor(() => expect(editors.has('a.ts')).toBe(true));
  expect(screen.getByRole('status').textContent).toContain('Loading file content');
  fireEvent.click(screen.getByRole('button', { name: 'Back to projects' }));
  expect(onBack).toHaveBeenCalledOnce();
  await sync();
  expect(loading()).toBeNull();
  expect(workspace.getAttribute('aria-hidden')).toBe('false');
  expect(workspace.hasAttribute('inert')).toBe(false);
  expect(screen.getByRole('button', { name: 'Run', exact: true }).disabled).toBe(false);
});

it('restores the active file first and opens while a background tab and app preview are unfinished', async () => {
  save(['background.ts', 'a.ts'], 'a.ts');
  const background = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path.includes('path=background.ts') ? background.promise : original(path, options),
  );
  mount();
  await sync();
  expect(loading()).toBeNull();
  expect(editors.has('background.ts')).toBe(false);
  const requests = vi
    .mocked(api)
    .mock.calls.map(([path]) => path)
    .filter((path) => path.includes('/file?'));
  expect(requests[0]).toContain('path=a.ts');
  expect(JSON.parse(localStorage.getItem(preferenceKey(user.id, project.id))!).tabs).toEqual([
    'background.ts',
    'a.ts',
  ]);
  await act(async () => background.resolve(file));
  await waitFor(() => expect(editors.has('background.ts')).toBe(true));
  expect(loading()).toBeNull();
  expect(JSON.parse(localStorage.getItem(preferenceKey(user.id, project.id))!).active).toBe('a.ts');
});

it('opens an empty project with a hidden sidebar and different saved tool, after its root file list loads', async () => {
  save([], '', { showSidebar: false, pane: 'git' });
  const files = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path.includes('/files?') ? files.promise : original(path, options),
  );
  mount();
  await act(async () => {});
  expect(loading()).toBeTruthy();
  expect(api).toHaveBeenCalledWith(
    '/projects/project/files?path=',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await act(async () => files.resolve([]));
  expect(loading()).toBeNull();
  expect(screen.getByText('Open a file from the sidebar to start working.')).toBeTruthy();
  expect(editors.size).toBe(0);
});

it('skips deleted and binary saved files and selects the next valid file', async () => {
  save(['deleted.ts', 'image.png', 'a.ts'], 'deleted.ts');
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) => {
    if (path.includes('path=deleted.ts'))
      return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
    if (path.includes('path=image.png')) return Promise.resolve({ binary: true });
    return original(path, options);
  });
  mount();
  await sync();
  expect(loading()).toBeNull();
  expect(editors.size).toBe(1);
  expect(JSON.parse(localStorage.getItem(preferenceKey(user.id, project.id))!).tabs).toEqual([
    'a.ts',
  ]);
});

it('waits for starter scaffolding, then synchronizes the starter file', async () => {
  vi.useFakeTimers();
  let p = {
    ...project,
    starterId: 'static-html',
    preparation: { ...project.preparation, status: 'files' as const },
  };
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === '/projects/project') return p;
    if (path.includes('/file?')) {
      if (p.preparation.status === 'files')
        throw Object.assign(new Error('Not found'), { status: 404 });
      return file;
    }
    if (path.includes('/files?')) return [];
    if (path.endsWith('/terminals')) return [shell];
    if (path.endsWith('/preparation')) return { jobs: [] };
    return [];
  });
  mount();
  await act(async () => {});
  expect(loading()).toBeTruthy();
  expect(editors.size).toBe(0);
  p = { ...p, preparation: { ...p.preparation, status: 'ready' as any } };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(editors.has('index.html')).toBe(true);
  act(() => editors.get('index.html')!());
  expect(loading()).toBeNull();
});

it('waits for first-terminal creation but does not create a shell for viewers', async () => {
  const creation = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path.endsWith('/terminals') ? Promise.resolve([]) : original(path, options),
  );
  vi.mocked(post).mockImplementation((path) =>
    path.endsWith('/terminals') ? creation.promise : Promise.resolve({}),
  );
  const view = mount();
  await act(async () => {});
  expect(loading()).toBeTruthy();
  await act(async () => creation.resolve(shell));
  expect(loading()).toBeNull();
  view.unmount();
  vi.mocked(post).mockClear();
  defaults({ ...project, role: 'viewer' });
  const viewer = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path.endsWith('/terminals') ? Promise.resolve([]) : viewer(path, options),
  );
  mount();
  await act(async () => {});
  expect(loading()).toBeNull();
  expect(post).not.toHaveBeenCalledWith('/projects/project/terminals', expect.anything());
});

it.each(['files', 'terminals', 'selection', 'document'] as const)(
  'reports an initial %s failure and retries only unfinished initialization',
  async (stage) => {
    save();
    const original = vi.mocked(api).getMockImplementation()!;
    let fail = true;
    vi.mocked(api).mockImplementation((path, options) => {
      const matches =
        stage === 'files'
          ? path.includes('/files?')
          : stage === 'terminals'
            ? path.endsWith('/terminals')
            : stage === 'selection'
              ? path.includes('/file?')
              : false;
      return fail && matches ? Promise.reject(new Error('Offline')) : original(path, options);
    });
    mount();
    if (stage === 'document') {
      await waitFor(() => expect(editors.has('a.ts')).toBe(true));
      act(() => editors.get('a.ts')!('Offline'));
    }
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Offline');
    const opens = vi.mocked(post).mock.calls.filter(([path]) => path.endsWith('/open')).length;
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await sync();
    await waitFor(() => expect(loading()).toBeNull());
    expect(vi.mocked(post).mock.calls.filter(([path]) => path.endsWith('/open'))).toHaveLength(
      opens,
    );
  },
);

it('shows slow loading after 30 seconds, retries a pending request, and ignores its late response', async () => {
  vi.useFakeTimers();
  const pending = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  let calls = 0;
  vi.mocked(api).mockImplementation((path, options) =>
    path.includes('/files?') && calls++ === 0 ? pending.promise : original(path, options),
  );
  mount();
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(screen.getByText(/taking longer than usual/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await act(async () => {});
  expect(loading()).toBeNull();
  await act(async () => pending.reject(new Error('Old request failed')));
  expect(screen.queryByText('Old request failed')).toBeNull();
  expect(loading()).toBeNull();
});

it('keeps loading through automatic startup without offering Start workspace, and retains failure logs', async () => {
  vi.useFakeTimers();
  let p = { ...project, state: 'stopped' as typeof project.state };
  const open = deferred<any>();
  vi.mocked(post).mockReturnValueOnce(open.promise);
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path === '/projects/project'
      ? Promise.resolve(p)
      : path.endsWith('/build-log')
        ? Promise.resolve({ log: 'Build failed' })
        : original(path, options),
  );
  mount();
  await act(async () => {});
  expect(loading()).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start workspace' })).toBeNull();
  await act(async () => open.resolve({}));
  expect(screen.queryByRole('button', { name: 'Start workspace' })).toBeNull();
  p = { ...p, state: 'failed', error: 'Environment failed' };
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole('alert').textContent).toBe('Environment failed');
  expect(screen.getAllByText('Build failed').length).toBeGreaterThan(0);
  p = { ...project };
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await act(async () => {});
  expect(loading()).toBeNull();
});

it('does not reopen the loading screen after polling failures or document reconnections', async () => {
  vi.useFakeTimers();
  save();
  mount();
  await act(async () => {});
  act(() => editors.get('a.ts')!());
  expect(loading()).toBeNull();
  act(() => editors.get('a.ts')!('Reconnecting'));
  vi.mocked(api).mockRejectedValueOnce(new Error('Polling offline'));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(screen.getByRole('alert').textContent).toContain('Polling offline');
  expect(loading()).toBeNull();
});

it('ignores responses from a project abandoned during loading', async () => {
  const pending = deferred<any>();
  const next = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path === '/projects/project'
      ? pending.promise
      : path === '/projects/next'
        ? next.promise
        : original(path, options),
  );
  const view = mount();
  view.rerender(
    <UiProvider>
      <Workspace key="next" id="next" user={user} onBack={vi.fn()} onOpen={vi.fn()} />
    </UiProvider>,
  );
  await act(async () => pending.resolve(project));
  expect(screen.queryByRole('heading', { name: project.name })).toBeNull();
  expect(loading()).toBeTruthy();
});

it('preserves a new file selection while background restoration finishes', async () => {
  save(['background.ts', 'a.ts'], 'a.ts');
  const background = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path.includes('path=background.ts')
      ? background.promise
      : path.includes('/files?')
        ? Promise.resolve([{ name: 'new.ts', path: 'new.ts', kind: 'file' }])
        : original(path, options),
  );
  mount();
  await sync();
  fireEvent.click(screen.getByText('new.ts'));
  await waitFor(() => expect(editors.has('new.ts')).toBe(true));
  await act(async () => background.resolve(file));
  await waitFor(() => expect(editors.has('background.ts')).toBe(true));
  expect(loading()).toBeNull();
  expect(JSON.parse(localStorage.getItem(preferenceKey(user.id, project.id))!).active).toBe(
    'new.ts',
  );
});

it('keeps a retried editor connection when switching to another restored tab', async () => {
  save(['a.ts', 'b.ts'], 'a.ts');
  mount();
  await waitFor(() => expect(editors.has('b.ts')).toBe(true));
  const initial = editors.get('a.ts');
  act(() => initial!('Offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(editors.get('a.ts')).not.toBe(initial));
  const retried = editors.get('a.ts');
  await sync();
  fireEvent.click(screen.getByRole('button', { name: 'b.ts' }));
  expect(editors.get('a.ts')).toBe(retried);
  expect(loading()).toBeNull();
});

it('does not let a pending environment build log block lifecycle polling or opening', async () => {
  vi.useFakeTimers();
  let p = { ...project, state: 'building' as typeof project.state };
  const log = deferred<any>();
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, options) =>
    path === '/projects/project'
      ? Promise.resolve(p)
      : path.endsWith('/build-log')
        ? log.promise
        : original(path, options),
  );
  const view = mount();
  await act(async () => {});
  expect(loading()).toBeTruthy();
  p = project;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(loading()).toBeNull();
  const request = vi.mocked(api).mock.calls.find(([path]) => path.endsWith('/build-log'))!;
  view.unmount();
  expect(request[1]?.signal?.aborted).toBe(true);
  await act(async () => log.reject(new Error('Abandoned log')));
  expect(screen.queryByText('Abandoned log')).toBeNull();
});

it('reports an automatic open failure and retries the environment request', async () => {
  defaults({ ...project, state: 'stopped' });
  vi.mocked(post).mockRejectedValueOnce(new Error('Worker unavailable'));
  mount();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Worker unavailable');
  defaults();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(loading()).toBeNull());
  expect(post).toHaveBeenCalledTimes(2);
});

it.each(['details', 'terminals', 'selection'] as const)(
  'ignores a late %s failure after retrying a pending request',
  async (stage) => {
    vi.useFakeTimers();
    save();
    const pending = deferred<any>();
    const original = vi.mocked(api).getMockImplementation()!;
    let calls = 0;
    vi.mocked(api).mockImplementation((path, options) => {
      const matches =
        stage === 'details'
          ? path === '/projects/project'
          : stage === 'terminals'
            ? path.endsWith('/terminals')
            : path.includes('/file?');
      return matches && calls++ === 0 ? pending.promise : original(path, options);
    });
    mount();
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(editors.has('a.ts')).toBe(true);
    act(() => editors.get('a.ts')!());
    expect(loading()).toBeNull();
    await act(async () => pending.reject(new Error('Stale response')));
    expect(screen.queryByText('Stale response')).toBeNull();
    expect(loading()).toBeNull();
  },
);
