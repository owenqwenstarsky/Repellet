// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../apps/web/src/App';
import { Auth } from '../../apps/web/src/Auth';
import { Admin } from '../../apps/web/src/Admin';
import { Projects } from '../../apps/web/src/Projects';
import { FileTree } from '../../apps/web/src/Files';
import { ProjectSettings } from '../../apps/web/src/Settings';
import { GitHubSettings } from '../../apps/web/src/GitHub';
import { Workspace } from '../../apps/web/src/Workspace';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post, put } from '../../apps/web/src/api';
import { deferred, project, user } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  errorMessage: (e: Error) => e.message,
  wsUrl: (s: string) => s,
  previewUrl: () => 'https://preview.test',
  formatBytes: () => '0 B',
}));
vi.mock('../../apps/web/src/Terminal', () => ({ Terminal: () => null }));
vi.mock('../../apps/web/src/CodeEditor', () => ({ CodeEditor: () => null }));
beforeEach(() => {
  history.replaceState(null, '', '/');
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) => {
      if (path === '/setup/status') return { required: false };
      if (path === '/auth/me') return { user };
      if (path === '/health') return { worker: true };
      if (path === '/projects' || path === '/admin/projects') return [project];
      if (path === '/projects/project') return project;
      if (path.includes('/files?')) return [{ name: 'one.ts', path: 'one.ts', kind: 'file' }];
      if (path.endsWith('/environment')) return { variables: {} };
      if (path.endsWith('/settings'))
        return {
          limits: { cpu: 1, memoryMb: 512, storageMb: 1024, maxActiveProjects: 3, idleMinutes: 10 },
        };
      if (path === '/users' || path === '/admin/users') return [user];
      if (path === '/github/connection')
        return { configured: true, connected: true, slug: 'app', login: 'owen', installationId: 1 };
      if (path === '/github/config') return { configured: true };
      if (path === '/github/installations')
        return [
          { id: 1, account: 'owen' },
          { id: 2, account: 'team' },
        ];
      return [];
    });
  vi.mocked(post).mockReset().mockResolvedValue({});
  vi.mocked(put).mockReset().mockResolvedValue({});
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  );
});
it('dismisses the account menu with Escape and restores account focus', async () => {
  const keyboard = userEvent.setup();
  render(<App />);
  const opener = await screen.findByRole('button', { name: 'Account for Owen' });
  await keyboard.click(opener);
  expect(screen.getByText('Sign out')).toBeTruthy();
  await keyboard.keyboard('{Escape}');
  expect(screen.queryByText('Sign out')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it('dismisses project actions with Escape and restores focus', async () => {
  const keyboard = userEvent.setup();
  render(
    <UiProvider>
      <Projects user={user} onOpen={vi.fn()} />
    </UiProvider>,
  );
  const opener = await screen.findByLabelText('Actions for Test project');
  await keyboard.click(opener);
  await keyboard.keyboard('{Escape}');
  expect(screen.queryByText('Rename')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it('counts live main apps and shows Idle for every other project lifecycle state', async () => {
  const list = [
    { ...project, id: 'app', name: 'Live app', running: true },
    { ...project, id: 'editor', name: 'Editor only', running: false },
    ...(['stopped', 'building', 'starting', 'stopping', 'failed'] as const).map((state) => ({
      ...project,
      id: state,
      name: state,
      state,
      running: false,
    })),
  ];
  vi.mocked(api).mockResolvedValue(list);
  const { container } = render(
    <UiProvider>
      <Projects user={user} onOpen={vi.fn()} />
    </UiProvider>,
  );
  await screen.findByText('Live app');
  expect(screen.getByText('1 running · Projects are private until you share them.')).toBeTruthy();
  expect(container.querySelectorAll('.status.running')).toHaveLength(1);
  expect(container.querySelectorAll('.status.idle')).toHaveLength(6);
  expect(screen.getAllByText('Idle')).toHaveLength(6);
});
it('uses app activity for admin badges while retaining workspace Stop controls', async () => {
  const fallback = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, options) =>
    path === '/admin/projects'
      ? [
          { ...project, id: 'app', name: 'Live app', running: true, canOpen: true },
          { ...project, id: 'idle', name: 'Editor only', running: false, canOpen: true },
          { ...project, id: 'failed', name: 'Failed workspace', state: 'failed', canOpen: true },
        ]
      : fallback(path, options),
  );
  const { container } = render(
    <UiProvider>
      <Admin onOpen={vi.fn()} />
    </UiProvider>,
  );
  await screen.findByRole('tab', { name: 'All projects' });
  fireEvent.click(screen.getByRole('tab', { name: 'All projects' }));
  await screen.findByText('Live app');
  expect(container.querySelectorAll('.status.running')).toHaveLength(1);
  expect(container.querySelectorAll('.status.idle')).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Stop workspace' })).toHaveLength(2);
});
it('dismisses file context menus with Escape and restores the file row', async () => {
  render(
    <UiProvider>
      <FileTree projectId="project" active="" revision={0} editable onOpen={vi.fn()} />
    </UiProvider>,
  );
  const row = await screen.findByText('one.ts');
  fireEvent.contextMenu(row.closest('button')!);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByText('Rename / move')).toBeNull();
  expect(document.activeElement).toBe(row.closest('button'));
});
it('prevents duplicate auth submissions and allows retry after failure', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ user });
  const onAuth = vi.fn();
  const view = render(<Auth setup={false} onAuth={onAuth} />);
  const form = view.container.querySelector('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new Error('Invalid credentials')));
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.submit(form);
  await waitFor(() => expect(onAuth).toHaveBeenCalledWith(user));
  expect(screen.queryByRole('alert')).toBeNull();
});
it('prevents duplicate password changes', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValue(pending.promise);
  const keyboard = userEvent.setup();
  render(<App />);
  await keyboard.click(await screen.findByRole('button', { name: 'Account for Owen' }));
  await keyboard.click(screen.getByText('Change password'));
  const form = screen.getByRole('dialog').querySelector('form')!;
  for (const input of form.querySelectorAll<HTMLInputElement>('input')) {
    fireEvent.change(input, {
      target: { value: input.type === 'password' ? 'long-password-123' : 'newperson' },
    });
  }
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ user }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('prevents duplicate administration account and resource submissions', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValue(pending.promise);
  render(
    <UiProvider>
      <Admin onOpen={vi.fn()} />
    </UiProvider>,
  );
  await screen.findByText('@owen');
  fireEvent.click(screen.getByText('Add person'));
  const form = screen.getByRole('dialog').querySelector('form')!;
  for (const input of form.querySelectorAll<HTMLInputElement>('input')) {
    fireEvent.change(input, {
      target: { value: input.type === 'password' ? 'long-password-123' : 'newperson' },
    });
  }
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({}));
  fireEvent.click(screen.getByText('Resources'));
  const save = screen.getByText('Save limits');
  const updating = deferred<any>();
  vi.mocked(put).mockReturnValue(updating.promise);
  act(() => {
    fireEvent.submit(save.closest('form')!);
    fireEvent.submit(save.closest('form')!);
  });
  expect(put).toHaveBeenCalledTimes(1);
});
it('prevents duplicate invitations', async () => {
  const pending = deferred<any>();
  vi.mocked(put).mockReturnValue(pending.promise);
  render(
    <UiProvider>
      <ProjectSettings
        project={project}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        onDuplicate={vi.fn()}
      />
    </UiProvider>,
  );
  fireEvent.click(screen.getByText('People'));
  await screen.findByRole('option', { name: 'Owen (@owen)' });
  fireEvent.change(screen.getByLabelText('User to invite'), { target: { value: user.id } });
  const form = screen.getByLabelText('User to invite').closest('form')!;
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(put).toHaveBeenCalledTimes(1);
});
it('prevents installation changes racing while GitHub settings are saving', async () => {
  const pending = deferred<any>();
  vi.mocked(put).mockReturnValue(pending.promise);
  render(
    <UiProvider>
      <GitHubSettings user={user} />
    </UiProvider>,
  );
  await screen.findByRole('option', { name: 'team' });
  const select = screen.getByLabelText('App installation');
  act(() => {
    fireEvent.change(select, { target: { value: '2' } });
    fireEvent.change(select, { target: { value: '1' } });
  });
  expect(put).toHaveBeenCalledTimes(1);
  expect((select as HTMLSelectElement).disabled).toBe(true);
});
it('cleans up resizing on pointer cancellation and unmount', async () => {
  const view = render(
    <UiProvider>
      <Workspace id="project" user={user} onBack={vi.fn()} onOpen={vi.fn()} />
    </UiProvider>,
  );
  await screen.findByLabelText('Project settings');
  fireEvent.pointerDown(screen.getAllByRole('separator')[0], { clientX: 100 });
  expect(document.body.classList.contains('resizing')).toBe(true);
  fireEvent.pointerCancel(window);
  expect(document.body.classList.contains('resizing')).toBe(false);
  fireEvent.pointerDown(screen.getAllByRole('separator')[0], { clientX: 100 });
  view.unmount();
  expect(document.body.classList.contains('resizing')).toBe(false);
});
it('ignores an authentication response after unmount', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValueOnce(pending.promise);
  const onAuth = vi.fn();
  const view = render(<Auth setup={false} onAuth={onAuth} />);
  fireEvent.submit(view.container.querySelector('form')!);
  view.unmount();
  await act(async () => pending.resolve({ user }));
  expect(onAuth).not.toHaveBeenCalled();
});
it('does not dismiss a newly opened password form when an older request completes', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValueOnce(pending.promise);
  const keyboard = userEvent.setup();
  render(<App />);
  const opener = await screen.findByRole('button', { name: 'Account for Owen' });
  await keyboard.click(opener);
  await keyboard.click(screen.getByText('Change password'));
  fireEvent.submit(screen.getByRole('dialog').querySelector('form')!);
  fireEvent.click(screen.getByText('Cancel'));
  await keyboard.click(opener);
  await keyboard.click(screen.getByText('Change password'));
  await act(async () => pending.resolve({ user }));
  expect(screen.getByRole('dialog')).toBeTruthy();
});
it('resolves a pending confirmation when its provider unmounts', async () => {
  const { useUi } = await import('../../apps/web/src/ui');
  let result: Promise<string | null> | undefined;
  function Ask() {
    const ui = useUi();
    return (
      <button
        onClick={() => {
          result = ui.ask({ title: 'Confirm', confirm: true });
        }}
      >
        Ask
      </button>
    );
  }
  const view = render(
    <UiProvider>
      <Ask />
    </UiProvider>,
  );
  fireEvent.click(screen.getByText('Ask'));
  view.unmount();
  const done = vi.fn();
  result!.then(done);
  await act(async () => {});
  expect(done).toHaveBeenCalledWith(null);
});
it('retains preview behavior and supports keyboard resizing without scrolling', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1440);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path) =>
    path === '/projects/project'
      ? Promise.resolve({
          ...project,
          previewPort: 3001,
          appStatus: { status: 'available', generation: 1 },
        })
      : original(path),
  );
  const view = render(
    <UiProvider>
      <Workspace id="project" user={user} onBack={vi.fn()} onOpen={vi.fn()} />
    </UiProvider>,
  );
  const preview = await screen.findByTitle('Project preview');
  fireEvent.click(screen.getByLabelText('Refresh preview'));
  expect(screen.getByTitle('Project preview')).not.toBe(preview);
  const separator = screen.getAllByRole('separator')[0];
  const explorer = view.container.querySelector('aside.explorer') as HTMLElement;
  const initial = parseFloat(explorer.style.width);
  expect(fireEvent.keyDown(separator, { key: 'ArrowRight' })).toBe(false);
  expect(parseFloat(explorer.style.width)).toBe(initial + 10);
});
