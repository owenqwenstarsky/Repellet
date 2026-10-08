// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { ProjectSettings } from '../../apps/web/src/Settings';
import { RepositorySetup } from '../../apps/web/src/RepositorySetup';
import { UiProvider } from '../../apps/web/src/ui';
import { api, patch, post, put, remove } from '../../apps/web/src/api';
import { project, deferred } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
const main = {
  id: 'main',
  name: 'Run',
  ...project.runConfig,
  environmentKeys: [],
  autoStart: true,
  isDefault: true,
  previewTargetId: 'app',
};
const extra = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Backend',
  command: 'node server.js',
  cwd: 'api',
  environmentKeys: ['PORT'],
  autoStart: true,
  isDefault: false,
  previewTargetId: '22222222-2222-4222-8222-222222222222',
};
beforeEach(() => {
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) =>
      path.endsWith('/run-profiles')
        ? [main, extra]
        : path.endsWith('/environment')
          ? { variables: {} }
          : [],
    );
  for (const fn of [patch, post, put, remove]) vi.mocked(fn).mockReset().mockResolvedValue({});
});
function settings(overrides = {}, logs = vi.fn(), close = vi.fn()) {
  return render(
    <UiProvider>
      <ProjectSettings
        project={{ ...project, ...overrides }}
        onChanged={vi.fn()}
        onClose={close}
        onDuplicate={vi.fn()}
        onViewPreparationLogs={logs}
      />
    </UiProvider>,
  );
}
function openRun() {
  fireEvent.click(screen.getByRole('tab', { name: 'Run', exact: true }));
}
it('shows one Run page with accessible explanations and collapsed advanced controls', async () => {
  const view = settings();
  openRun();
  expect(screen.queryByRole('tab', { name: 'Run profiles' })).toBeNull();
  const run = screen.getByRole('textbox', { name: 'Run command' });
  expect(document.getElementById(run.getAttribute('aria-describedby')!)?.textContent).toContain(
    'Starts your app',
  );
  expect(screen.getByText(/Saving this command does not run it/)).toBeTruthy();
  expect(view.container.querySelector('details[open]')).toBeNull();
  fireEvent.click(screen.getByText(/^Advanced/));
  expect(
    ((await screen.findByRole('checkbox', { name: 'Start automatically' })) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(screen.getByText(/0.0.0.0/)).toBeTruthy();
});
it('saves both commands and automatic start while stopped without executing anything', async () => {
  settings({ state: 'stopped', preparation: { ...project.preparation, status: 'pending' } });
  openRun();
  await waitFor(() =>
    expect((screen.getByLabelText('Start automatically') as HTMLInputElement).checked).toBe(true),
  );
  fireEvent.change(screen.getByLabelText('Run command'), { target: { value: 'npm start' } });
  fireEvent.change(screen.getByLabelText('Install command (optional)'), {
    target: { value: 'npm ci' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/projects/project', {
      runConfig: { ...project.runConfig, command: 'npm start' },
      setupCommand: 'npm ci',
      runAutoStart: true,
    }),
  );
  expect(post).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});
it('disables installation for drafts and stopped workspaces with an explanation', async () => {
  settings({ state: 'stopped', setupCommand: 'npm ci' });
  openRun();
  expect(
    (screen.getByRole('button', { name: 'Install dependencies' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText('Start the workspace to install dependencies.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Run command'), { target: { value: 'npm start' } });
  expect(screen.getByText('Save your changes before installing dependencies.')).toBeTruthy();
});
it('opens preparation logs and closes settings', () => {
  const logs = vi.fn(),
    close = vi.fn();
  settings({}, logs, close);
  openRun();
  fireEvent.click(screen.getByRole('button', { name: 'View preparation logs' }));
  expect(logs).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it('keeps additional-command drafts across tab switches and preserves hidden configuration on save', async () => {
  settings();
  openRun();
  fireEvent.click(await screen.findByText('Additional commands (1)'));
  expect(screen.queryByRole('button', { name: 'Edit Run' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit Backend' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'API' } });
  fireEvent.click(screen.getByRole('tab', { name: 'General' }));
  openRun();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('API');
  fireEvent.click(screen.getByRole('button', { name: 'Save command' }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith(`/projects/project/run-profiles/${extra.id}`, {
      name: 'API',
      command: extra.command,
      cwd: 'api',
      environmentKeys: ['PORT'],
      autoStart: true,
      previewTargetId: '22222222-2222-4222-8222-222222222222',
    }),
  );
  expect(post).not.toHaveBeenCalled();
});
it('explains why an active additional command cannot be deleted', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/run-profiles')
      ? [main, extra]
      : path.endsWith('/processes')
        ? [{ id: 'process', profileId: extra.id, status: 'running' }]
        : [],
  );
  settings();
  openRun();
  fireEvent.click(await screen.findByText('Additional commands (1)'));
  fireEvent.click(screen.getByRole('button', { name: 'Edit Backend' }));
  expect(
    (screen.getByRole('button', { name: 'Delete command' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText('Stop this command before deleting it.')).toBeTruthy();
});
it('keeps save errors inline and suppresses duplicate saves', async () => {
  const pending = deferred<unknown>();
  vi.mocked(patch).mockReturnValue(pending.promise);
  render(
    <UiProvider>
      <RepositorySetup project={project} onChanged={vi.fn()} />
    </UiProvider>,
  );
  fireEvent.change(screen.getByLabelText('Run command'), { target: { value: 'npm start' } });
  const save = screen.getByRole('button', { name: 'Save changes' });
  act(() => {
    fireEvent.click(save);
    fireEvent.click(save);
  });
  expect(patch).toHaveBeenCalledOnce();
  await act(async () => pending.reject(new Error('Installation is in progress.')));
  expect(screen.getByRole('alert').textContent).toContain('Installation is in progress.');
});
it('preserves default automatic start if its settings could not load', async () => {
  vi.mocked(api).mockRejectedValue(new Error('Offline'));
  render(
    <UiProvider>
      <RepositorySetup project={project} onChanged={vi.fn()} />
    </UiProvider>,
  );
  await screen.findByText('Offline');
  fireEvent.change(screen.getByLabelText('Run command'), { target: { value: 'npm start' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/projects/project', {
      runConfig: { ...project.runConfig, command: 'npm start' },
      setupCommand: '',
    }),
  );
});
