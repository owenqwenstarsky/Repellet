// @vitest-environment jsdom
import { useState } from 'react';
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GitHubPicker } from '../../apps/web/src/GitHub';
import { Projects } from '../../apps/web/src/Projects';
import { ProjectSettings } from '../../apps/web/src/Settings';
import { RepositorySetup } from '../../apps/web/src/RepositorySetup';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post, put, patch } from '../../apps/web/src/api';
import { registerDocumentSave } from '../../apps/web/src/documentSaves';
import { deferred, project, repos, user, suggestion } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
beforeEach(() => {
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) =>
      path === '/github/repositories'
        ? repos
        : path === '/projects'
          ? [project]
          : path.endsWith('/environment')
            ? { variables: { TOKEN: 'secret' } }
            : [],
    );
  vi.mocked(post).mockReset().mockResolvedValue({});
  vi.mocked(put).mockReset().mockResolvedValue({});
  vi.mocked(patch).mockReset().mockResolvedValue({});
});
function Picker() {
  const [value, setValue] = useState<(typeof repos)[number] | null>(null);
  return <GitHubPicker {...{ value }} onSelect={setValue} />;
}
it('keeps the selected repository when filtering excludes it', async () => {
  render(<Picker />);
  await screen.findByRole('option', { name: 'owen/one' });
  fireEvent.change(screen.getByLabelText('GitHub repository'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Filter repositories'), { target: { value: 'two' } });
  expect((screen.getByLabelText('GitHub repository') as HTMLSelectElement).value).toBe('1');
});
it('shows loading, errors, retry and empty repository states', async () => {
  const pending = deferred<any>();
  vi.mocked(api).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
  render(<Picker />);
  expect(screen.getByText('Loading repositories…')).toBeTruthy();
  await act(async () => pending.reject(new Error('Offline')));
  expect(screen.getByRole('alert').textContent).toContain('Offline');
  fireEvent.click(screen.getByText('Retry repositories'));
  await screen.findByText('No repositories available.');
  expect(screen.queryByRole('alert')).toBeNull();
});
async function creation() {
  render(
    <UiProvider>
      <Projects user={user} onOpen={vi.fn()} />
    </UiProvider>,
  );
  await screen.findByText('Test project');
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
  fireEvent.change(screen.getByLabelText('Project source'), { target: { value: 'github' } });
  await screen.findByRole('option', { name: 'owen/one' });
}
it('creates the HTML starter with its Node environment and no-install help', async () => {
  render(
    <UiProvider>
      <Projects user={user} onOpen={vi.fn()} />
    </UiProvider>,
  );
  await screen.findByText('Test project');
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
  fireEvent.change(screen.getByLabelText('Project source'), { target: { value: 'static-html' } });
  expect(screen.getByText(/No dependency installation needed/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /Node.js/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'My static site' } });
  fireEvent.submit(screen.getByLabelText('Project name').closest('form')!);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects',
      expect.objectContaining({ starterId: 'static-html', runtimes: ['node'] }),
    ),
  );
});
it('preserves runtime edits while detection is pending', async () => {
  const pending = deferred<any>();
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('/suggestion?')
      ? pending.promise
      : path === '/github/repositories'
        ? repos
        : [project],
  );
  await creation();
  fireEvent.change(screen.getByLabelText('GitHub repository'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: /Go1/ }));
  await act(async () => pending.resolve(suggestion));
  expect(screen.getByRole('button', { name: /Go1/ }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', { name: /Python3/ }).getAttribute('aria-pressed')).toBe(
    'false',
  );
  expect(screen.getByText(/Detected: python/)).toBeTruthy();
});
it('ignores detection from a previous repository, source and unmounted form', async () => {
  const first = deferred<any>(),
    second = deferred<any>();
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('/1/suggestion?')
      ? first.promise
      : path.includes('/2/suggestion?')
        ? second.promise
        : path === '/github/repositories'
          ? repos
          : [project],
  );
  await creation();
  fireEvent.change(screen.getByLabelText('GitHub repository'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('GitHub repository'), { target: { value: '2' } });
  await act(async () => second.resolve({ ...suggestion, runtimes: ['go'] }));
  await act(async () => first.resolve(suggestion));
  expect(screen.getByRole('button', { name: /Go1/ }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByLabelText('Project source'), { target: { value: 'blank' } });
  expect(screen.queryByText(/Detected:/)).toBeNull();
  fireEvent.click(screen.getByText('Cancel'));
});
for (const role of ['editor', 'viewer'] as const)
  it(`opens an accessible tab for an imported ${role} project`, async () => {
    render(
      <UiProvider>
        <ProjectSettings
          project={{ ...project, role, runConfig: { ...project.runConfig, command: '' } }}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onDuplicate={vi.fn()}
        />
      </UiProvider>,
    );
    expect(screen.getByLabelText('Project name')).toBeTruthy();
    expect(screen.queryByText('Confirm and prepare')).toBeNull();
    expect(screen.queryByText('Save changes')).toBeNull();
  });
it('prevents editing or saving environment variables until loading succeeds, and offers retry', async () => {
  const pending = deferred<any>();
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/environment') ? pending.promise : [],
  );
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
  fireEvent.click(screen.getByText('Environment'));
  expect((screen.getByText('Add variable') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await act(async () => pending.reject(new Error('Secrets unavailable')));
  expect(screen.getByText('Retry environment')).toBeTruthy();
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/environment') ? { variables: { TOKEN: 'secret' } } : [],
  );
  fireEvent.click(screen.getByText('Retry environment'));
  await screen.findByLabelText('Variable name 1');
  expect((screen.getByLabelText('Variable value 1') as HTMLInputElement).value).toBe('secret');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/projects/project/environment', {
      runtimes: ['node'],
      variables: { TOKEN: 'secret' },
    }),
  );
});
it('refreshes untouched settings from polling while keeping edits', async () => {
  const props = { onClose: vi.fn(), onChanged: vi.fn(), onDuplicate: vi.fn() };
  const view = render(
    <UiProvider>
      <ProjectSettings project={project} {...props} />
    </UiProvider>,
  );
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Unsaved' } });
  view.rerender(
    <UiProvider>
      <ProjectSettings
        project={{ ...project, description: 'Updated', runConfig: suggestion.runConfig }}
        {...props}
      />
    </UiProvider>,
  );
  expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('Unsaved');
  expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('Updated');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/projects/project', {
      name: 'Unsaved',
      description: 'Updated',
    }),
  );
});
it('invalidates pending manifest suggestions when cwd changes and applies the full suggestion', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValueOnce(pending.promise).mockResolvedValue(suggestion);
  render(
    <UiProvider>
      <RepositorySetup project={project} onChanged={vi.fn()} />
    </UiProvider>,
  );
  fireEvent.click(screen.getByText('Detect commands'));
  fireEvent.change(screen.getByLabelText('Project folder'), {
    target: { value: 'other' },
  });
  await act(async () => pending.resolve(suggestion));
  expect(screen.queryByText('Use suggestions')).toBeNull();
  fireEvent.click(screen.getByText('Detect commands'));
  await screen.findByText('Use suggestions');
  fireEvent.click(screen.getByText('Use suggestions'));
  expect((screen.getByLabelText('Project folder') as HTMLInputElement).value).toBe('server');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/projects/project', {
      setupCommand: suggestion.setupCommand,
      runConfig: suggestion.runConfig,
    }),
  );
});
it('ignores runtime detection after a source change and after unmount', async () => {
  const pending = deferred<any>();
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('/suggestion?')
      ? pending.promise
      : path === '/github/repositories'
        ? repos
        : [project],
  );
  await creation();
  fireEvent.change(screen.getByLabelText('GitHub repository'), { target: { value: '1' } });
  fireEvent.change(screen.getByLabelText('Project source'), { target: { value: 'blank' } });
  await act(async () => pending.resolve(suggestion));
  expect(screen.getByRole('button', { name: /Node.js24/ }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.queryByText(/Detected:/)).toBeNull();
  const late = deferred<any>();
  vi.mocked(api).mockImplementation(async (path) =>
    path.includes('/suggestion?') ? late.promise : repos,
  );
  fireEvent.change(screen.getByLabelText('Project source'), { target: { value: 'github' } });
  await screen.findByRole('option', { name: 'owen/one' });
  fireEvent.change(screen.getByLabelText('GitHub repository'), { target: { value: '1' } });
  fireEvent.click(screen.getByText('Cancel'));
  await act(async () => late.reject(new Error('Late detection')));
  expect(screen.queryByText('Late detection')).toBeNull();
});
it('edits run settings in one place and keeps General saves to project details', async () => {
  const pending = deferred<void>();
  vi.mocked(patch).mockReturnValueOnce(pending.promise);
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
  expect(screen.queryByRole('textbox', { name: 'Run command' })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: 'Run', exact: true }));
  fireEvent.change(screen.getByLabelText('Run command'), {
    target: { value: 'new command' },
  });
  fireEvent.change(screen.getByLabelText('Project folder'), {
    target: { value: 'server' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith('/projects/project', {
      runConfig: { command: 'new command', cwd: 'server', port: 3000 },
      setupCommand: project.setupCommand,
    }),
  );
  const general = screen.getByRole('tab', { name: 'General' }) as HTMLButtonElement;
  expect(general.disabled).toBe(true);
  await act(async () => pending.resolve());
  await waitFor(() => expect(general.disabled).toBe(false));
  fireEvent.click(general);
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(patch).toHaveBeenLastCalledWith('/projects/project', {
      name: project.name,
      description: project.description,
    }),
  );
});
it('keeps dirty run fields stable during polling and refreshes them after a confirmed save', async () => {
  const props = { onClose: vi.fn(), onChanged: vi.fn(), onDuplicate: vi.fn() };
  const view = render(
    <UiProvider>
      <ProjectSettings project={project} {...props} />
    </UiProvider>,
  );
  fireEvent.click(screen.getByRole('tab', { name: 'Run', exact: true }));
  fireEvent.change(screen.getByLabelText('Run command'), { target: { value: 'manual' } });
  view.rerender(
    <UiProvider>
      <ProjectSettings
        project={{ ...project, runConfig: { ...project.runConfig, command: 'external' } }}
        {...props}
      />
    </UiProvider>,
  );
  expect((screen.getByLabelText('Run command') as HTMLInputElement).value).toBe('manual');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  view.rerender(
    <UiProvider>
      <ProjectSettings
        project={{ ...project, runConfig: { ...project.runConfig, command: 'manual' } }}
        {...props}
      />
    </UiProvider>,
  );
  view.rerender(
    <UiProvider>
      <ProjectSettings
        project={{ ...project, runConfig: { ...project.runConfig, command: 'next' } }}
        {...props}
      />
    </UiProvider>,
  );
  expect((screen.getByLabelText('Run command') as HTMLInputElement).value).toBe('next');
});
it('returns to General when ownership changes while a restricted tab is open', async () => {
  const props = { onClose: vi.fn(), onChanged: vi.fn(), onDuplicate: vi.fn() };
  const view = render(
    <UiProvider>
      <ProjectSettings project={project} {...props} />
    </UiProvider>,
  );
  fireEvent.click(screen.getByText('Environment'));
  await screen.findByLabelText('Variable value 1');
  view.rerender(
    <UiProvider>
      <ProjectSettings project={{ ...project, role: 'viewer' }} {...props} />
    </UiProvider>,
  );
  expect(screen.getByLabelText('Project name')).toBeTruthy();
  expect(screen.queryByLabelText('Variable value 1')).toBeNull();
  expect(screen.queryByText('Save changes')).toBeNull();
});
it('prevents duplicate project creation and allows retry after a failed submission', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(project);
  await creation();
  const form = screen.getByRole('dialog').querySelector('form')!;
  // Choose Blank so validation does not stop submission before the request.
  fireEvent.change(screen.getByLabelText('Project source'), { target: { value: 'blank' } });
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'New project' } });
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => pending.reject(new Error('Create failed')));
  expect(screen.getByRole('alert').textContent).toContain('Create failed');
  fireEvent.submit(form);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('refreshes untouched repository fields during polling without losing edits', () => {
  const view = render(
    <UiProvider>
      <RepositorySetup project={project} onChanged={vi.fn()} />
    </UiProvider>,
  );
  fireEvent.change(screen.getByLabelText('Install command (optional)'), {
    target: { value: 'manual install' },
  });
  view.rerender(
    <UiProvider>
      <RepositorySetup
        project={{ ...project, setupCommand: 'external install', runConfig: suggestion.runConfig }}
        onChanged={vi.fn()}
      />
    </UiProvider>,
  );
  expect((screen.getByLabelText('Install command (optional)') as HTMLInputElement).value).toBe(
    'manual install',
  );
  expect((screen.getByLabelText('Run command') as HTMLInputElement).value).toBe(
    suggestion.runConfig.command,
  );
});
it('serializes repository setup actions', async () => {
  const pending = deferred<any>();
  vi.mocked(post).mockReturnValue(pending.promise);
  render(
    <UiProvider>
      <RepositorySetup project={{ ...project, setupCommand: 'npm ci' }} onChanged={vi.fn()} />
    </UiProvider>,
  );
  const confirm = screen.getByText('Install dependencies');
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
});
it.each(['Detect commands', 'Install dependencies'])(
  'waits for editor saves before %s',
  async (action) => {
    const pending = deferred<void>();
    const unregister = registerDocumentSave(project.id, 'package.json', () => pending.promise);
    vi.mocked(post).mockResolvedValue(suggestion);
    try {
      render(
        <UiProvider>
          <RepositorySetup project={{ ...project, setupCommand: 'npm ci' }} onChanged={vi.fn()} />
        </UiProvider>,
      );
      fireEvent.click(screen.getByText(action));
      await act(async () => {});
      expect(post).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      await act(async () => pending.resolve());
      if (action === 'Detect commands') {
        expect(post).toHaveBeenCalledWith('/projects/project/setup/suggest', { cwd: '' });
        expect(screen.getByText('Use suggestions')).toBeTruthy();
      } else {
        expect(post).toHaveBeenCalledWith('/projects/project/prepare');
        expect(put).not.toHaveBeenCalled();
      }
    } finally {
      unregister();
    }
  },
);
it('invalidates manifest inspection when cwd changes during an editor save', async () => {
  const pending = deferred<void>();
  const unregister = registerDocumentSave(project.id, 'package.json', () => pending.promise);
  vi.mocked(post).mockResolvedValue(suggestion);
  try {
    render(
      <UiProvider>
        <RepositorySetup project={project} onChanged={vi.fn()} />
      </UiProvider>,
    );
    fireEvent.click(screen.getByText('Detect commands'));
    fireEvent.change(screen.getByLabelText('Project folder'), {
      target: { value: 'other' },
    });
    await act(async () => pending.resolve());
    expect(post).toHaveBeenCalledWith('/projects/project/setup/suggest', { cwd: '' });
    expect(screen.queryByText('Use suggestions')).toBeNull();
  } finally {
    unregister();
  }
});
