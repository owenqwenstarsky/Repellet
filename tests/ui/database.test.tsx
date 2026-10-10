// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DatabaseResult } from '@repellet/shared';
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
function recordMenu(record = 1) {
  fireEvent.click(screen.getByRole('button', { name: `Record ${record} actions` }));
  return within(screen.getByRole('menu'));
}
function deferredRead() {
  let resolve!: (result: DatabaseResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<DatabaseResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
  fireEvent.click(recordMenu().getByRole('menuitem', { name: 'Edit' }));
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
  fireEvent.click(recordMenu().getByRole('menuitem', { name: 'Delete' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete record?' });
  expect(vi.mocked(post).mock.calls.some(([, body]: any) => body.operation === 'delete')).toBe(
    false,
  );
  fireEvent.click(within(dialog).getByText('Cancel'));
  fireEvent.click(screen.getByText('Database details'));
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
  const menu = recordMenu();
  expect((menu.getByRole('menuitem', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
  expect((menu.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('Insert record') as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(menu.getByRole('menuitem', { name: 'View record' }));
  expect(screen.getByRole('dialog', { name: 'View record' })).toBeTruthy();
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
it('collapses connection guidance and deletion while keeping startup failures and retry visible', async () => {
  vi.mocked(api).mockResolvedValue({
    ...ready,
    status: 'failed',
    error: 'Database startup failed',
  });
  panel();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Database startup failed');
  const details = screen.getByText('Database details').closest('details')!;
  expect(details.open).toBe(false);
  expect(details.contains(screen.getByText('Delete database'))).toBe(true);
  const retry = screen.getByRole('button', { name: 'Retry database' });
  expect(details.contains(retry)).toBe(false);
  fireEvent.click(retry);
  await waitFor(() => expect(post).toHaveBeenCalledWith('/projects/project/database/retry'));
});
it('withholds database creation from editors when no database exists', async () => {
  vi.mocked(api).mockResolvedValue(null);
  panel(false);
  await screen.findByText('The project owner can create a database here.');
  expect(screen.queryByLabelText('Database type')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create database' })).toBeNull();
});
it('shows full multiline values, JSON, arrays and generated fields in the read-only record viewer', async () => {
  const description = `${'Detailed project brief. '.repeat(160)}\nLast line beyond the old preview limit.`;
  const longName = 'a_very_long_column_name_that_must_remain_inspectable';
  const record = {
    id: '1',
    [longName]: description,
    metadata: { nested: { title: 'Full value' } },
    tags: ['one', 'two'],
    empty: '',
    optional: null,
  };
  const wideColumns = [
    columns[0],
    { ...columns[1], name: longName },
    { ...columns[1], name: 'metadata', type: 'jsonb' },
    { ...columns[1], name: 'tags', type: 'text[]' },
    { ...columns[1], name: 'empty' },
    { ...columns[1], name: 'optional', nullable: true },
  ];
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema'
      ? { objects: [{ name: 'projects', schema: 'public', columns: wideColumns }] }
      : { rows: [record], columns: wideColumns },
  );
  panel();
  const grid = await screen.findByRole('region', { name: 'Records' });
  expect(within(grid).getByTitle(longName).textContent).toContain(longName);
  expect(within(grid).getByLabelText('Primary key')).toBeTruthy();
  expect(within(grid).getByText('NULL')).toBeTruthy();
  expect(within(grid).getByText('Empty string')).toBeTruthy();
  fireEvent.click(recordMenu().getByRole('menuitem', { name: 'View record' }));
  const dialog = screen.getByRole('dialog', { name: 'View record' });
  expect(within(dialog).getByText('Generated')).toBeTruthy();
  expect(within(dialog).getByText('1').tagName).toBe('PRE');
  expect(dialog.querySelector('input, textarea')).toBeNull();
  const values = [...dialog.querySelectorAll('pre')].map((pre) => pre.textContent);
  expect(values).toContain(description);
  expect(values).toContain(JSON.stringify(record.metadata, null, 2));
  expect(values).toContain(JSON.stringify(record.tags, null, 2));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close', exact: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    vi
      .mocked(post)
      .mock.calls.every(([, body]: any) => ['schema', 'read'].includes(body.operation)),
  ).toBe(true);
});
it('distinguishes missing MongoDB fields from NULL, empty strings, false and zero', async () => {
  vi.mocked(api).mockResolvedValue({ ...ready, type: 'mongodb' });
  const objectId = { $oid: '507f1f77bcf86cd799439011' };
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema'
      ? { objects: [{ name: 'users' }] }
      : {
          rows: [
            { _id: objectId, name: '', optional: null, active: false, count: 0 },
            { _id: { $oid: '507f1f77bcf86cd799439012' } },
          ],
        },
  );
  panel(false);
  const grid = await screen.findByRole('region', { name: 'Records' });
  expect(within(grid).getByText('NULL')).toBeTruthy();
  expect(within(grid).getByText('Empty string')).toBeTruthy();
  expect(within(grid).getAllByText('Missing')).toHaveLength(4);
  expect(within(grid).getByText('false')).toBeTruthy();
  expect(within(grid).getByText('0')).toBeTruthy();
  fireEvent.click(recordMenu().getByRole('menuitem', { name: 'Edit' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit record' });
  const changed = { _id: objectId, name: 'Changed', optional: null, active: false, count: 0 };
  fireEvent.change(within(dialog).getByLabelText('Document JSON'), {
    target: { value: JSON.stringify(changed) },
  });
  fireEvent.click(within(dialog).getByText('Save record'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'update',
      name: 'users',
      values: changed,
      key: { _id: objectId },
    }),
  );
});
it('supports keyboard row menus and restores focus after viewing a record', async () => {
  const user = userEvent.setup();
  panel();
  const trigger = await screen.findByRole('button', { name: 'Record 1 actions' });
  trigger.focus();
  await user.keyboard('{Enter}');
  const menu = within(screen.getByRole('menu'));
  expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: 'View record' }));
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: 'Edit' }));
  await user.keyboard('{End}');
  expect(document.activeElement).toBe(menu.getByRole('menuitem', { name: 'Delete' }));
  await user.keyboard('{Home}{Enter}');
  expect(screen.getByRole('dialog', { name: 'View record' })).toBeTruthy();
  expect(screen.queryByRole('menu')).toBeNull();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard('{Enter}{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it('paginates in 100-record offsets, disables navigation while loading and resets on object changes', async () => {
  const nextPage = deferredRead();
  vi.mocked(post).mockImplementation(async (_path, body: any) => {
    if (body.operation === 'schema')
      return {
        objects: [
          { name: 'users', schema: 'public', columns },
          { name: 'events', schema: 'audit', columns },
        ],
      };
    if (body.name === 'events') return { rows: [{ id: '2', name: 'Event' }], columns };
    if (body.offset === 100) return nextPage.promise;
    return {
      rows: Array.from({ length: 100 }, (_, index) => ({
        id: String(index + 1),
        name: `User ${index + 1}`,
      })),
      columns,
      hasMore: true,
    };
  });
  panel();
  await screen.findByText('Records 1–100');
  const previous = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
  const next = screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  expect(previous.disabled).toBe(true);
  fireEvent.click(next);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'read',
      name: 'users',
      schema: 'public',
      offset: 100,
    }),
  );
  expect(previous.disabled).toBe(true);
  expect(next.disabled).toBe(true);
  expect(screen.queryByText('User 1', { exact: true })).toBeNull();
  await act(async () =>
    nextPage.resolve({ rows: [{ id: '101', name: 'Last user' }], columns, hasMore: false }),
  );
  await screen.findByText('Records 101–101');
  expect(previous.disabled).toBe(false);
  expect(next.disabled).toBe(true);
  fireEvent.click(previous);
  await screen.findByText('Records 1–100');
  fireEvent.click(next);
  await screen.findByText('Page 2');
  fireEvent.change(screen.getByLabelText('Database object'), {
    target: { value: JSON.stringify(['audit', 'events']) },
  });
  await screen.findByText('Event');
  expect(screen.getByText('Page 1')).toBeTruthy();
  expect(screen.getByText('Records 1–1')).toBeTruthy();
  expect(previous.disabled).toBe(true);
  expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
    operation: 'read',
    name: 'events',
    schema: 'audit',
    offset: 0,
  });
});
it('ignores a stale record response after switching objects', async () => {
  const oldRead = deferredRead();
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema'
      ? {
          objects: [
            { name: 'users', schema: 'public', columns },
            { name: 'events', schema: 'audit', columns },
          ],
        }
      : body.name === 'users'
        ? oldRead.promise
        : { rows: [{ id: '1', name: 'Latest object' }], columns },
  );
  panel();
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'read',
      name: 'users',
      schema: 'public',
      offset: 0,
    }),
  );
  fireEvent.change(screen.getByLabelText('Database object'), {
    target: { value: JSON.stringify(['audit', 'events']) },
  });
  await screen.findByText('Latest object');
  await act(async () => oldRead.resolve({ rows: [{ id: '2', name: 'Stale object' }], columns }));
  expect(screen.getByText('Latest object')).toBeTruthy();
  expect(screen.queryByText('Stale object')).toBeNull();
});
it('ignores a stale read failure after switching objects', async () => {
  const oldRead = deferredRead();
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema'
      ? {
          objects: [
            { name: 'users', columns },
            { name: 'events', columns },
          ],
        }
      : body.name === 'users'
        ? oldRead.promise
        : { rows: [{ id: '1', name: 'Current record' }], columns },
  );
  panel();
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'read',
      name: 'users',
      offset: 0,
    }),
  );
  fireEvent.change(screen.getByLabelText('Database object'), {
    target: { value: JSON.stringify(['', 'events']) },
  });
  await screen.findByText('Current record');
  await act(async () => oldRead.reject(new Error('Old request failed')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('Retry records')).toBeNull();
  expect(screen.getByText('Current record')).toBeTruthy();
});
it('retries failed reads without leaving a loading spinner or enabling pagination', async () => {
  const retry = deferredRead();
  let reads = 0;
  vi.mocked(post).mockImplementation(async (_path, body: any) => {
    if (body.operation === 'schema')
      return { objects: [{ name: 'users', schema: 'public', columns }] };
    if (reads++ === 0) throw new Error('Could not read records');
    return retry.promise;
  });
  panel();
  expect((await screen.findByRole('alert')).textContent).toBe('Could not read records');
  expect(screen.queryByText('Loading records…')).toBeNull();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry records' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getAllByText('Loading records…').length).toBeGreaterThan(0);
  await act(async () => retry.resolve({ rows: [{ id: '1', name: 'Recovered' }], columns }));
  await screen.findByText('Recovered');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Records 1–1')).toBeTruthy();
});
it('offers creation when the catalog is empty', async () => {
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema' ? { objects: [] } : { affected: 1 },
  );
  panel(false);
  await screen.findByText('No tables yet');
  fireEvent.click(screen.getByRole('button', { name: 'Create table' }));
  const dialog = screen.getByRole('dialog', { name: 'Create table' });
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'new_table' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'create',
      name: 'new_table',
    }),
  );
});
it('offers insertion for an empty page and keeps result-limit notices outside the grid', async () => {
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema'
      ? { objects: [{ name: 'users', schema: 'public', columns }] }
      : { rows: [], columns, truncated: true },
  );
  panel();
  await screen.findByText('No records on this page');
  expect(screen.getByText('0 records on this page')).toBeTruthy();
  const notice = screen.getByText('Result limited. Use a narrower command to inspect more.');
  expect(screen.getByRole('region', { name: 'Records' }).contains(notice)).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Insert a record' }));
  const dialog = screen.getByRole('dialog', { name: 'Insert record' });
  expect((within(dialog).getByLabelText('name uses default') as HTMLInputElement).checked).toBe(
    true,
  );
  fireEvent.click(within(dialog).getByText('Save record'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'insert',
      name: 'users',
      schema: 'public',
      values: {},
    }),
  );
});
it('preserves the distinction between defaults, empty text and NULL during insertion', async () => {
  const nullableColumns = [
    ...columns,
    { ...columns[1], name: 'nickname', nullable: true },
    { ...columns[1], name: 'unchanged' },
  ];
  vi.mocked(post).mockImplementation(async (_path, body: any) =>
    body.operation === 'schema'
      ? { objects: [{ name: 'users', schema: 'public', columns: nullableColumns }] }
      : body.operation === 'read'
        ? { rows: [], columns: nullableColumns }
        : { affected: 1 },
  );
  panel();
  await screen.findByText('No records on this page');
  fireEvent.click(screen.getByRole('button', { name: 'Insert record', exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Insert record' });
  fireEvent.click(within(dialog).getByLabelText('name uses default'));
  fireEvent.click(within(dialog).getByLabelText('nickname is null'));
  fireEvent.click(within(dialog).getByText('Save record'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'insert',
      name: 'users',
      schema: 'public',
      values: { name: '', nickname: null },
    }),
  );
});
it('keeps PostgreSQL schema operations and their destructive confirmations', async () => {
  panel(false);
  await screen.findByText('Owen');
  fireEvent.click(screen.getByRole('tab', { name: 'Schema' }));
  const grid = screen.getByRole('table', { name: 'Database columns' });
  const row = within(grid).getByText('name', { exact: true }).closest('tr')!;
  fireEvent.click(within(row).getByText('Rename'));
  let dialog = screen.getByRole('dialog', { name: 'Rename column' });
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'display_name' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'rename_column',
      name: 'users',
      schema: 'public',
      column: 'name',
      newName: 'display_name',
    }),
  );
  await waitFor(() =>
    expect((within(row).getByText('Delete') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(within(row).getByText('Delete'));
  dialog = screen.getByRole('dialog', { name: 'Delete column name?' });
  expect(vi.mocked(post).mock.calls.some(([, body]: any) => body.operation === 'drop_column')).toBe(
    false,
  );
  fireEvent.click(within(dialog).getByText('Confirm'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'drop_column',
      name: 'users',
      schema: 'public',
      column: 'name',
    }),
  );
  await waitFor(() =>
    expect((screen.getByText('Add column') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByText('Add column'));
  dialog = screen.getByRole('dialog', { name: 'Add column' });
  fireEvent.change(within(dialog).getByLabelText('Column name'), { target: { value: 'notes' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add column' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'add_column',
      name: 'users',
      schema: 'public',
      column: 'notes',
      type: 'text',
      nullable: true,
    }),
  );
  await waitFor(() =>
    expect((screen.getByText('Add column') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Table actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete table' }));
  dialog = screen.getByRole('dialog', { name: 'Delete users?' });
  expect(vi.mocked(post).mock.calls.some(([, body]: any) => body.operation === 'drop')).toBe(false);
  fireEvent.click(within(dialog).getByText('Cancel'));
});
it('executes SQL statements and displays returned results', async () => {
  panel();
  await screen.findByText('Owen');
  fireEvent.click(screen.getByRole('tab', { name: 'Console' }));
  const sql = 'SELECT * FROM users LIMIT 100;';
  fireEvent.change(screen.getByLabelText('Database command'), { target: { value: sql } });
  fireEvent.click(screen.getByText('Execute command'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/database/operations', {
      operation: 'execute_sql',
      sql,
      parameters: [],
    }),
  );
  await screen.findByText('1 affected or returned records.');
  expect(screen.getByText('{ "affected": 1 }', { exact: false })).toBeTruthy();
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
