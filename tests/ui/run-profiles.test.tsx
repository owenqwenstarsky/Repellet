// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunProfiles } from '../../apps/web/src/RunProfiles';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post } from '../../apps/web/src/api';
import { registerDocumentSave } from '../../apps/web/src/documentSaves';
import { project, deferred } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
const profile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'API',
  command: 'node server.js',
  cwd: '',
  environmentKeys: [],
  autoStart: false,
  isDefault: false,
};
beforeEach(() => {
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path) => (path.endsWith('/run-profiles') ? [profile] : []));
  vi.mocked(post).mockReset().mockResolvedValue({});
});
it('allows typing several environment names without losing separators', async () => {
  render(
    <UiProvider>
      <RunProfiles project={project} />
    </UiProvider>,
  );
  await screen.findByText('API');
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Profile name'), 'Frontend');
  await user.type(screen.getByLabelText('Command'), 'npm start');
  await user.type(screen.getByLabelText('Environment variable names'), 'PORT, PUBLIC_URL');
  await user.click(screen.getByRole('button', { name: 'Add profile' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/projects/project/run-profiles',
      expect.objectContaining({ name: 'Frontend', environmentKeys: ['PORT', 'PUBLIC_URL'] }),
    ),
  );
});
it('flushes collaborative documents before an editor starts a profile', async () => {
  const save = deferred<void>();
  const unregister = registerDocumentSave(project.id, 'open.ts', () => save.promise);
  try {
    render(
      <UiProvider>
        <RunProfiles project={{ ...project, role: 'editor' }} />
      </UiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Run API' }));
    expect(post).not.toHaveBeenCalled();
    save.resolve();
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/projects/project/run-profiles/${profile.id}/start`),
    );
    expect(screen.queryByLabelText('Profile name')).toBeNull();
  } finally {
    unregister();
  }
});
it('shows viewer process status without allowing execution or configuration', async () => {
  render(
    <UiProvider>
      <RunProfiles project={{ ...project, role: 'viewer' }} />
    </UiProvider>,
  );
  expect(
    ((await screen.findByRole('button', { name: 'Run API' })) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect((screen.getByRole('button', { name: 'Task API' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.queryByLabelText('Profile name')).toBeNull();
});
