// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DatabasePanel } from '../../apps/web/src/DatabasePanel';
import { ProjectSettings } from '../../apps/web/src/Settings';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post, put, remove } from '../../apps/web/src/api';
import { project } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
const ready = {
  id: 'database',
  type: 'postgresql',
  image: 'postgres:17-alpine',
  status: 'ready',
  variableName: 'DATABASE_URL',
  error: null,
};
const columns = [
  { name: 'id', type: 'bigint', primaryKey: true, nullable: false, generated: true },
  { name: 'name', type: 'text', primaryKey: false, nullable: false },
];
beforeEach(() => {
  vi.mocked(api).mockReset().mockResolvedValue(ready);
  vi.mocked(post)
    .mockReset()
    .mockImplementation(async (_path, body: any) =>
      body.operation === 'schema'
        ? { objects: [{ name: 'users', schema: 'public', columns }] }
        : body.operation === 'read'
          ? { rows: [{ id: '1', name: 'Owen' }], columns, hasMore: false }
          : { affected: 1 },
    );
  vi.mocked(put).mockReset().mockResolvedValue({});
  vi.mocked(remove).mockReset().mockResolvedValue({});
});
function panel(owner = true, onClose = vi.fn()) {
  render(
    <UiProvider>
      <DatabasePanel projectId="project" owner={owner} onClose={onClose} />
    </UiProvider>,
  );
  return onClose;
}
it('provides engine selection only to owners and closes without deleting a database', async () => {
  vi.mocked(api).mockResolvedValue(null);
  const onClose = panel();
  await screen.findByText('Add a development database');
  fireEvent.change(screen.getByLabelText('Database type'), { target: { value: 'mongodb' } });
  fireEvent.click(screen.getByText('Create database'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database', { type: 'mongodb' }),
  );
  fireEvent.click(screen.getByLabelText('Close Database tab'));
  expect(onClose).toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
it('lets editors edit data/schema while withholding database deletion', async () => {
  panel(false);
  await screen.findByText('Owen');
  expect(screen.queryByText('Delete database')).toBeNull();
  fireEvent.click(screen.getByText('Edit', { exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Edit record' });
  fireEvent.change(within(dialog).getByLabelText('name'), { target: { value: 'Changed' } });
  fireEvent.click(within(dialog).getByText('Save record'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'update',
      name: 'users',
      schema: 'public',
      values: { name: 'Changed' },
      key: { id: '1' },
    }),
  );
});
it('requires confirmation before destructive record and lifecycle actions', async () => {
  panel();
  await screen.findByText('Owen');
  fireEvent.click(screen.getByText('Delete', { exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Delete record?' });
  expect(vi.mocked(post).mock.calls.some(([, body]: any) => body.operation === 'delete')).toBe(
    false,
  );
  fireEvent.click(within(dialog).getByText('Cancel'));
  fireEvent.click(screen.getByText('Delete database'));
  const deleting = screen.getByRole('dialog', { name: 'Delete database?' });
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(deleting).getByText('Confirm'));
  await waitFor(() => expect(remove).toHaveBeenCalledWith('/projects/project/database'));
});
it('disables ambiguous record targeting for a table without a primary key', async () => {
  const noKey = columns.map((column) => ({ ...column, primaryKey: false }));
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema'
      ? { objects: [{ name: 'users', columns: noKey }] }
      : { rows: [{ id: '1', name: 'Owen' }], columns: noKey },
  );
  panel(false);
  await screen.findByText('Owen');
  expect((screen.getByText('Edit') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('Delete', { exact: true }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('Insert record') as HTMLButtonElement).disabled).toBe(false);
});
it('submits structured MongoDB commands and displays errors without evaluating scripts', async () => {
  vi.mocked(api).mockResolvedValue({ ...ready, type: 'mongodb' });
  panel();
  await screen.findByText('MongoDB', { exact: true });
  fireEvent.click(screen.getByRole('tab', { name: 'Console' }));
  fireEvent.change(screen.getByLabelText('Database command'), {
    target: { value: '{"find":"users"}' },
  });
  fireEvent.click(screen.getByText('Execute command'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'execute_mongo',
      command: { find: 'users' },
    }),
  );
  fireEvent.change(screen.getByLabelText('Database command'), {
    target: { value: 'db.users.find()' },
  });
  await waitFor(() =>
    expect((screen.getByText('Execute command') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByText('Execute command'));
  await screen.findByRole('alert');
});
it('protects managed values in settings and submits an explicit rename with its revision', async () => {
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('/environment')
      ? {
          variables: { DATABASE_URL: 'connection' },
          runtimes: ['node'],
          revision: 4,
          databaseVariableName: 'DATABASE_URL',
        }
      : [],
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
  const input = await screen.findByLabelText('Variable value 1');
  expect((input as HTMLInputElement).readOnly).toBe(true);
  expect((screen.getByLabelText('Remove variable 1') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Variable name 1'), { target: { value: 'DB' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith('/projects/project/environment', {
      runtimes: ['node'],
      variables: { DB: 'connection' },
      revision: 4,
      databaseVariableName: 'DB',
      renames: { DATABASE_URL: 'DB' },
    }),
  );
});
