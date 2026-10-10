import { useEffect, useRef, useState } from 'react';
import { Database, KeyRound, MoreHorizontal, Plus, RefreshCw, X } from 'lucide-react';
import type {
  DatabaseColumn,
  DatabaseOperation,
  DatabaseResult,
  DatabaseStatus,
  DatabaseType,
} from '@repellet/shared';
import { databaseColumnTypeSchema } from '@repellet/shared';
import { api, post, remove, errorMessage } from './api';
import { Button, IconButton, MenuButton, MenuItem, Modal, Spinner, Tabs, useUi } from './ui';

type Table = { name: string; schema?: string; columns?: DatabaseColumn[] };
const tableKey = (table: Table) => JSON.stringify([table.schema || '', table.name]);
const cell = (value: unknown) =>
  value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
const columnWidth = (column?: DatabaseColumn) => {
  if (!column) return 220;
  if (column.type === 'uuid') return 240;
  if (/text|char|json/.test(column.type) || column.type.endsWith('[]')) return 260;
  return 160;
};
function DisplayValue({ value, full = false }: { value: unknown; full?: boolean }) {
  if (value === null) return <span className="database-value-null">NULL</span>;
  if (value === undefined) return <span className="database-value-missing">Missing</span>;
  if (value === '') return <span className="database-value-empty">Empty string</span>;
  const text = full && typeof value === 'object' ? JSON.stringify(value, null, 2) : cell(value);
  return full ? <pre>{text}</pre> : <span className="database-cell-value">{text}</span>;
}
export function postgresEditorValue(value: string, column: DatabaseColumn): unknown {
  if (column.type === 'json' || column.type === 'jsonb' || column.type.endsWith('[]'))
    return JSON.parse(value);
  if (column.type === 'boolean') {
    if (!['true', 'false'].includes(value)) throw new Error(`${column.name} must be true or false`);
    return value === 'true';
  }
  return value;
}
export function DatabasePanel({
  projectId,
  owner,
  revision = 0,
  onClose,
}: {
  projectId: string;
  owner: boolean;
  revision?: number;
  onClose: () => void;
}) {
  const ui = useUi(),
    base = `/projects/${projectId}/database`;
  const [database, setDatabase] = useState<DatabaseStatus | null>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<DatabaseType>('postgresql');
  const [objects, setObjects] = useState<Table[]>([]);
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<DatabaseResult>();
  const [readError, setReadError] = useState('');
  const [dataRevision, setDataRevision] = useState(0);
  const [section, setSection] = useState<'data' | 'schema' | 'console'>('data');
  const [command, setCommand] = useState('');
  const [result, setResult] = useState<DatabaseResult>();
  const [editing, setEditing] = useState<{ row?: Record<string, unknown> }>();
  const [viewing, setViewing] = useState<Record<string, unknown>>();
  const [addingColumn, setAddingColumn] = useState(false);
  const alive = useRef(true),
    statusRequest = useRef(0),
    dataRequest = useRef(0);
  const table = objects.find((object) => tableKey(object) === selected);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      statusRequest.current++;
      dataRequest.current++;
    };
  }, []);
  async function load() {
    const request = ++statusRequest.current;
    try {
      const status = await api<DatabaseStatus | null>(base);
      if (!alive.current || request !== statusRequest.current) return;
      setDatabase(status);
      setError('');
      if (status?.status === 'ready') {
        const catalog = await post<DatabaseResult>(base + '/operations', { operation: 'schema' });
        if (!alive.current || request !== statusRequest.current) return;
        const next = catalog.objects || [];
        setObjects(next);
        setSelected((value) =>
          next.some((table) => tableKey(table) === value)
            ? value
            : next[0]
              ? tableKey(next[0])
              : '',
        );
        if (catalog.truncated)
          setError('Catalog is truncated. Use commands to inspect a smaller selection.');
      } else {
        setObjects([]);
        setSelected('');
        setData(undefined);
      }
    } catch (error) {
      if (alive.current && request === statusRequest.current) setError(errorMessage(error));
    }
  }
  async function loadData() {
    const request = ++dataRequest.current;
    setData(undefined);
    setReadError('');
    if (!table || database?.status !== 'ready') {
      return;
    }
    try {
      const value = await post<DatabaseResult>(base + '/operations', {
        operation: 'read',
        name: table.name,
        ...(table.schema ? { schema: table.schema } : {}),
        offset: page * 100,
      });
      if (alive.current && request === dataRequest.current) {
        setData(value);
      }
    } catch (error) {
      if (alive.current && request === dataRequest.current) setReadError(errorMessage(error));
    }
  }
  useEffect(() => {
    void load();
  }, [projectId, revision]);
  useEffect(() => {
    void loadData();
  }, [selected, page, database?.id, database?.status, revision, dataRevision, objects]);
  async function run(action: () => Promise<unknown>, refresh = true): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await action();
      if (refresh && alive.current) {
        await load();
        setDataRevision((value) => value + 1);
      }
      return true;
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const target = table
    ? { name: table.name, ...(table.schema ? { schema: table.schema } : {}) }
    : {};
  const execute = (operation: DatabaseOperation) =>
    post<DatabaseResult>(base + '/operations', operation);
  async function drop() {
    if (
      !table ||
      !(await ui.ask({
        title: `Delete ${table.name}?`,
        description: 'This permanently deletes this table or collection and its contents.',
        confirm: true,
        danger: true,
      }))
    )
      return;
    await run(() => execute({ operation: 'drop', ...target } as DatabaseOperation));
  }
  async function createObject() {
    const name = await ui.ask({
      title: database?.type === 'postgresql' ? 'Create table' : 'Create collection',
      label: 'Name',
      maxLength: 63,
    });
    if (name) await run(() => execute({ operation: 'create', name }));
  }
  async function deleteRow(row: Record<string, unknown>) {
    if (
      !(await ui.ask({
        title: 'Delete record?',
        description: 'This permanently deletes the selected record.',
        confirm: true,
        danger: true,
      }))
    )
      return;
    await run(() =>
      execute({ operation: 'delete', ...target, key: recordKey(row) } as DatabaseOperation),
    );
  }
  function recordKey(row: Record<string, unknown>) {
    if (database?.type === 'mongodb') return { _id: row._id };
    return Object.fromEntries(
      (data?.columns || table?.columns || [])
        .filter((column) => column.primaryKey)
        .map((column) => [column.name, row[column.name]]),
    );
  }
  const columns = data?.columns || table?.columns || [];
  const canTarget = database?.type === 'mongodb' || columns.some((column) => column.primaryKey);
  const names =
    database?.type === 'postgresql'
      ? columns.map((column) => column.name)
      : [...new Set((data?.rows || []).flatMap((row) => Object.keys(row)))].slice(0, 100);
  const widths = names.map((name) =>
    columnWidth(database?.type === 'postgresql' ? columns.find((c) => c.name === name) : undefined),
  );
  const recordCount = data?.rows?.length || 0;
  return (
    <div className="database-panel">
      <header className="database-header">
        <Database size={17} />
        <strong>Database</strong>
        <IconButton
          label="Refresh database"
          icon={<RefreshCw size={15} />}
          disabled={busy}
          onClick={() => void run(async () => {}, true)}
        />
        <IconButton label="Close Database tab" icon={<X size={16} />} onClick={onClose} />
      </header>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {database === undefined ? (
        error ? (
          <Button onClick={() => void load()}>Retry database</Button>
        ) : (
          <Spinner />
        )
      ) : database === null ? (
        <div className="database-empty">
          <h3>Add a development database</h3>
          <p className="muted">
            One database per project. Data persists when your workspace stops.
          </p>
          {owner ? (
            <>
              <label>
                Database type
                <select
                  value={engine}
                  onChange={(event) => setEngine(event.target.value as DatabaseType)}
                  disabled={busy}
                >
                  <option value="postgresql">PostgreSQL 17</option>
                  <option value="mongodb">MongoDB 8.0</option>
                </select>
              </label>
              <Button
                variant="primary"
                busy={busy}
                onClick={() => void run(() => post(base, { type: engine }))}
              >
                Create database
              </Button>
            </>
          ) : (
            <p>The project owner can create a database here.</p>
          )}
        </div>
      ) : (
        <>
          <div className="database-connection">
            <div className="database-connection-summary">
              <strong>{database.type === 'postgresql' ? 'PostgreSQL' : 'MongoDB'}</strong>
              <span className={`status ${database.status}`}>
                <i aria-hidden="true" />
                {database.status}
              </span>
              {owner && ['failed', 'stopped', 'creating'].includes(database.status) && (
                <Button size="sm" busy={busy} onClick={() => void run(() => post(base + '/retry'))}>
                  Retry database
                </Button>
              )}
            </div>
            {database.error && (
              <p role="alert" className="field-error">
                {database.error}
              </p>
            )}
            <details className="database-details">
              <summary>Database details</summary>
              <p>
                Applications connect with <code>{database.variableName}</code>.
              </p>
              <p className="muted">
                Rename the connection variable in Project settings → Environment. Its value is
                managed by Repellet.
              </p>
              {owner && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await ui.ask({
                        title: 'Delete database?',
                        description:
                          'This permanently deletes all database data and its connection variable. You can then create a fresh PostgreSQL or MongoDB database.',
                        confirm: true,
                        danger: true,
                      })
                    )
                      await run(() => remove(base));
                  }}
                >
                  {database.status === 'deleting' ? 'Retry deletion' : 'Delete database'}
                </Button>
              )}
            </details>
          </div>
          {database.status === 'ready' && (
            <>
              <Tabs
                label="Database views"
                value={section}
                onChange={setSection}
                items={[
                  { id: 'data', label: 'Data' },
                  { id: 'schema', label: 'Schema' },
                  { id: 'console', label: 'Console' },
                ]}
              />
              {section !== 'console' ? (
                <>
                  <div className="database-toolbar">
                    <label className="database-selector">
                      <span>{database.type === 'postgresql' ? 'Table' : 'Collection'}</span>
                      <select
                        aria-label="Database object"
                        value={selected}
                        disabled={busy || !objects.length}
                        onChange={(event) => {
                          setSelected(event.target.value);
                          setPage(0);
                        }}
                      >
                        <option value="" disabled>
                          Select an object
                        </option>
                        {objects.map((table) => (
                          <option key={tableKey(table)} value={tableKey(table)}>
                            {table.schema ? `${table.schema}.` : ''}
                            {table.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {objects.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void createObject()}
                      >
                        Create {database.type === 'postgresql' ? 'table' : 'collection'}
                      </Button>
                    )}
                    {table &&
                      (section === 'data' ? (
                        <Button
                          size="sm"
                          variant="primary"
                          icon={<Plus size={13} />}
                          disabled={busy}
                          onClick={() => setEditing({})}
                        >
                          Insert record
                        </Button>
                      ) : (
                        <>
                          {database.type === 'postgresql' && (
                            <Button
                              size="sm"
                              icon={<Plus size={13} />}
                              disabled={busy}
                              onClick={() => setAddingColumn(true)}
                            >
                              Add column
                            </Button>
                          )}
                          <MenuButton
                            label={
                              database.type === 'postgresql'
                                ? 'Table actions'
                                : 'Collection actions'
                            }
                            icon={<MoreHorizontal size={16} />}
                          >
                            <MenuItem danger disabled={busy} onSelect={() => void drop()}>
                              Delete {database.type === 'postgresql' ? 'table' : 'collection'}
                            </MenuItem>
                          </MenuButton>
                        </>
                      ))}
                  </div>
                  {!objects.length && (
                    <div className="database-empty database-workspace-state">
                      <Database size={24} aria-hidden="true" />
                      <h3>No {database.type === 'postgresql' ? 'tables' : 'collections'} yet</h3>
                      <p className="muted">
                        Create a {database.type === 'postgresql' ? 'table' : 'collection'} to start
                        adding records.
                      </p>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy}
                        onClick={() => void createObject()}
                      >
                        Create {database.type === 'postgresql' ? 'table' : 'collection'}
                      </Button>
                    </div>
                  )}
                  {table &&
                    (section === 'data' ? (
                      <>
                        {!canTarget && (
                          <p className="muted database-notice">
                            This table has no primary key. Use the console to update or delete
                            records.
                          </p>
                        )}
                        {readError ? (
                          <div className="database-workspace-state">
                            <p role="alert" className="field-error">
                              {readError}
                            </p>
                            <Button size="sm" onClick={() => void loadData()}>
                              Retry records
                            </Button>
                          </div>
                        ) : data ? (
                          <div
                            className="database-grid"
                            role="region"
                            aria-label="Records"
                            tabIndex={0}
                          >
                            <table
                              aria-label="Database records"
                              style={{ width: widths.reduce((sum, width) => sum + width, 48) }}
                            >
                              <colgroup>
                                {names.map((name, index) => (
                                  <col key={name} style={{ width: widths[index] }} />
                                ))}
                                <col style={{ width: 48 }} />
                              </colgroup>
                              <thead>
                                <tr>
                                  {names.map((name) => {
                                    const column =
                                      database.type === 'postgresql'
                                        ? columns.find((c) => c.name === name)
                                        : undefined;
                                    return (
                                      <th key={name} scope="col" title={name}>
                                        <div className="database-column-name">
                                          {column?.primaryKey && (
                                            <KeyRound size={12} aria-label="Primary key" />
                                          )}
                                          <span>{name}</span>
                                        </div>
                                        {column && (
                                          <span
                                            className="database-column-type"
                                            title={column.type}
                                          >
                                            {column.type}
                                          </span>
                                        )}
                                      </th>
                                    );
                                  })}
                                  <th scope="col" className="database-row-actions">
                                    <span className="sr-only">Actions</span>
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {data.rows?.map((row, index) => (
                                  <tr key={index}>
                                    {names.map((name) => (
                                      <td key={name} title={cell(row[name]).slice(0, 2000)}>
                                        <DisplayValue value={row[name]} />
                                      </td>
                                    ))}
                                    <td className="database-row-actions">
                                      <MenuButton
                                        label={`Record ${page * 100 + index + 1} actions`}
                                        icon={<MoreHorizontal size={16} />}
                                      >
                                        <MenuItem onSelect={() => setViewing(row)}>
                                          View record
                                        </MenuItem>
                                        <MenuItem
                                          disabled={busy || !canTarget}
                                          onSelect={() => setEditing({ row })}
                                        >
                                          Edit
                                        </MenuItem>
                                        <MenuItem
                                          danger
                                          disabled={busy || !canTarget}
                                          onSelect={() => void deleteRow(row)}
                                        >
                                          Delete
                                        </MenuItem>
                                      </MenuButton>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {!recordCount && (
                              <div className="database-empty">
                                <h3>No records on this page</h3>
                                <p className="muted">
                                  {page === 0
                                    ? 'Insert the first record to populate this object.'
                                    : 'Return to the previous page or insert a record.'}
                                </p>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => setEditing({})}
                                >
                                  Insert a record
                                </Button>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="database-workspace-state" role="status">
                            <Spinner label="Loading records…" />
                          </div>
                        )}
                        <footer className="database-footer">
                          <span className="database-record-range" role="status">
                            {data
                              ? recordCount
                                ? `Records ${page * 100 + 1}–${page * 100 + recordCount}`
                                : '0 records on this page'
                              : readError
                                ? 'Records unavailable'
                                : 'Loading records…'}
                          </span>
                          <div
                            className="database-pagination"
                            role="group"
                            aria-label="Record pages"
                          >
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || !data || page === 0}
                              onClick={() => setPage((page) => page - 1)}
                            >
                              Previous
                            </Button>
                            <span>Page {page + 1}</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy || !data?.hasMore}
                              onClick={() => setPage((page) => page + 1)}
                            >
                              Next
                            </Button>
                          </div>
                          {data?.truncated && (
                            <p className="muted database-limit">
                              Result limited. Use a narrower command to inspect more.
                            </p>
                          )}
                        </footer>
                      </>
                    ) : (
                      <>
                        {database.type === 'mongodb' ? (
                          <p className="muted">
                            MongoDB collections contain documents with flexible fields. Edit
                            documents in Data; manage indexes and validation in Console.
                          </p>
                        ) : (
                          <div
                            className="database-grid database-schema-grid"
                            role="region"
                            aria-label="Schema"
                            tabIndex={0}
                          >
                            <table aria-label="Database columns" style={{ width: 664 }}>
                              <colgroup>
                                <col style={{ width: 160 }} />
                                <col style={{ width: 260 }} />
                                <col style={{ width: 100 }} />
                                <col style={{ width: 144 }} />
                              </colgroup>
                              <thead>
                                <tr>
                                  <th scope="col">Column</th>
                                  <th scope="col">Type</th>
                                  <th scope="col">Nullable</th>
                                  <th scope="col" className="database-row-actions">
                                    Actions
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {columns.map((column) => (
                                  <tr key={column.name}>
                                    <td title={column.name}>
                                      <div className="database-column-name">
                                        {column.primaryKey && (
                                          <KeyRound size={12} aria-label="Primary key" />
                                        )}
                                        <span>{column.name}</span>
                                      </div>
                                    </td>
                                    <td title={column.type}>
                                      <span className="database-cell-value">{column.type}</span>
                                    </td>
                                    <td>{column.nullable ? 'Yes' : 'No'}</td>
                                    <td className="database-row-actions">
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={async () => {
                                          const newName = await ui.ask({
                                            title: 'Rename column',
                                            value: column.name,
                                            maxLength: 63,
                                          });
                                          if (newName)
                                            await run(() =>
                                              execute({
                                                operation: 'rename_column',
                                                ...target,
                                                column: column.name,
                                                newName,
                                              } as DatabaseOperation),
                                            );
                                        }}
                                      >
                                        Rename
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="danger-text"
                                        disabled={busy}
                                        onClick={async () => {
                                          if (
                                            await ui.ask({
                                              title: `Delete column ${column.name}?`,
                                              description:
                                                'This permanently deletes the column and all its values.',
                                              confirm: true,
                                              danger: true,
                                            })
                                          )
                                            await run(() =>
                                              execute({
                                                operation: 'drop_column',
                                                ...target,
                                                column: column.name,
                                              } as DatabaseOperation),
                                            );
                                        }}
                                      >
                                        Delete
                                      </Button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    ))}
                </>
              ) : (
                <form
                  className="database-console"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      const operation: DatabaseOperation =
                        database.type === 'postgresql'
                          ? { operation: 'execute_sql', sql: command, parameters: [] }
                          : { operation: 'execute_mongo', command: JSON.parse(command) };
                      const response = await execute(operation);
                      if (alive.current) {
                        setResult(response);
                        await load();
                        setDataRevision((value) => value + 1);
                      }
                    }, false);
                  }}
                >
                  <label>
                    {database.type === 'postgresql'
                      ? 'SQL statement'
                      : 'MongoDB command (Extended JSON)'}
                    <textarea
                      className="mono-input"
                      aria-label="Database command"
                      value={command}
                      required
                      maxLength={65536}
                      rows={7}
                      onChange={(event) => setCommand(event.target.value)}
                      placeholder={
                        database.type === 'postgresql'
                          ? 'SELECT * FROM users LIMIT 100;'
                          : '{"find":"users","filter":{},"limit":100}'
                      }
                    />
                  </label>
                  <Button type="submit" size="sm" variant="primary" busy={busy}>
                    Execute command
                  </Button>
                  <p className="muted">
                    {database.type === 'postgresql'
                      ? 'One statement per request.'
                      : 'Structured commands; no shell JavaScript.'}{' '}
                    Results are limited to 1,000 records and 1 MiB.
                  </p>
                  {result && (
                    <>
                      <p>
                        {result.affected !== undefined &&
                          `${result.affected} affected or returned records.`}
                        {result.truncated && ' Result truncated.'}
                      </p>
                      <pre className="database-result">
                        {JSON.stringify(result.rows ?? result.result ?? result, null, 2)}
                      </pre>
                    </>
                  )}
                </form>
              )}
            </>
          )}
        </>
      )}
      {viewing && (
        <Modal title="View record" onClose={() => setViewing(undefined)}>
          <dl className="database-record-view">
            {[...new Set([...names, ...Object.keys(viewing)])].map((name) => {
              const column =
                database?.type === 'postgresql' ? columns.find((c) => c.name === name) : undefined;
              return (
                <div key={name}>
                  <dt>
                    <span>{name}</span>
                    {column && <span className="muted">{column.type}</span>}
                    {column?.primaryKey && <span className="muted">Primary key</span>}
                    {column?.generated && <span className="muted">Generated</span>}
                  </dt>
                  <dd>
                    <DisplayValue value={viewing[name]} full />
                  </dd>
                </div>
              );
            })}
          </dl>
          <div className="modal-actions">
            <Button onClick={() => setViewing(undefined)}>Close</Button>
          </div>
        </Modal>
      )}
      {editing && table && database && (
        <RecordEditor
          engine={database.type}
          columns={columns}
          row={editing.row}
          onClose={() => setEditing(undefined)}
          onSave={async (values) => {
            if (
              await run(() =>
                execute({
                  operation: editing.row ? 'update' : 'insert',
                  ...target,
                  values,
                  ...(editing.row ? { key: recordKey(editing.row) } : {}),
                } as DatabaseOperation),
              )
            )
              setEditing(undefined);
          }}
          busy={busy}
        />
      )}
      {addingColumn && table && (
        <ColumnEditor
          busy={busy}
          onClose={() => setAddingColumn(false)}
          onSave={async (column, type, nullable) => {
            if (
              await run(() =>
                execute({
                  operation: 'add_column',
                  ...target,
                  column,
                  type,
                  nullable,
                } as DatabaseOperation),
              )
            )
              setAddingColumn(false);
          }}
        />
      )}
    </div>
  );
}

function RecordEditor({
  engine,
  columns,
  row,
  busy,
  onClose,
  onSave,
}: {
  engine: DatabaseType;
  columns: DatabaseColumn[];
  row?: Record<string, unknown>;
  busy: boolean;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => Promise<void>;
}) {
  const [document, setDocument] = useState(JSON.stringify(row || {}, null, 2));
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      columns.map((column) => [
        column.name,
        row?.[column.name] == null ? '' : cell(row[column.name]),
      ]),
    ),
  );
  const [defaults, setDefaults] = useState(
    new Set(row ? [] : columns.map((column) => column.name)),
  );
  const [nulls, setNulls] = useState(
    new Set(
      columns.filter((column) => row && row[column.name] === null).map((column) => column.name),
    ),
  );
  const [error, setError] = useState('');
  return (
    <Modal title={row ? 'Edit record' : 'Insert record'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          try {
            const next =
              engine === 'mongodb'
                ? JSON.parse(document)
                : Object.fromEntries(
                    columns
                      .filter((column) => !column.generated && !(row && column.primaryKey))
                      .filter((column) => row || !defaults.has(column.name))
                      .map((column) => [
                        column.name,
                        nulls.has(column.name)
                          ? null
                          : postgresEditorValue(values[column.name] || '', column),
                      ]),
                  );
            if (!next || typeof next !== 'object' || Array.isArray(next))
              throw new Error('Provide a JSON object');
            void onSave(next);
          } catch (error) {
            setError(errorMessage(error));
          }
        }}
      >
        {engine === 'mongodb' ? (
          <label>
            Document (Extended JSON)
            <textarea
              aria-label="Document JSON"
              className="mono-input"
              rows={12}
              value={document}
              disabled={busy}
              onChange={(event) => setDocument(event.target.value)}
            />
          </label>
        ) : (
          <div className="database-record-fields">
            {columns
              .filter((column) => !column.generated)
              .map((column) => (
                <label key={column.name}>
                  {column.name} <span className="muted">({column.type})</span>
                  <input
                    aria-label={column.name}
                    className="mono-input"
                    value={values[column.name] || ''}
                    disabled={busy || nulls.has(column.name) || (!!row && column.primaryKey)}
                    onChange={(event) => {
                      setValues((values) => ({ ...values, [column.name]: event.target.value }));
                      setDefaults((previous) => {
                        const next = new Set(previous);
                        next.delete(column.name);
                        return next;
                      });
                    }}
                    placeholder={!row ? 'Leave empty to use database default' : ''}
                  />
                  {!row && (
                    <span>
                      <input
                        type="checkbox"
                        aria-label={`${column.name} uses default`}
                        checked={defaults.has(column.name)}
                        disabled={busy}
                        onChange={(event) =>
                          setDefaults((previous) => {
                            const next = new Set(previous);
                            event.target.checked ? next.add(column.name) : next.delete(column.name);
                            return next;
                          })
                        }
                      />{' '}
                      Use default
                    </span>
                  )}
                  {column.nullable && (
                    <span>
                      <input
                        type="checkbox"
                        aria-label={`${column.name} is null`}
                        checked={nulls.has(column.name)}
                        disabled={busy}
                        onChange={(event) => {
                          setDefaults((previous) => {
                            const next = new Set(previous);
                            next.delete(column.name);
                            return next;
                          });
                          setNulls((previous) => {
                            const next = new Set(previous);
                            event.target.checked ? next.add(column.name) : next.delete(column.name);
                            return next;
                          });
                        }}
                      />{' '}
                      NULL
                    </span>
                  )}
                </label>
              ))}
          </div>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Save record
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ColumnEditor({
  busy,
  onClose,
  onSave,
}: {
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, type: string, nullable: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [type, setType] = useState('text'),
    [nullable, setNullable] = useState(true);
  return (
    <Modal title="Add column" onClose={onClose} small>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(name, type, nullable);
        }}
      >
        <label>
          Column name
          <input
            aria-label="Column name"
            required
            maxLength={63}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Column type
          <select
            aria-label="Column type"
            value={type}
            disabled={busy}
            onChange={(event) => setType(event.target.value)}
          >
            {databaseColumnTypeSchema.options.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={nullable}
            disabled={busy}
            onChange={(event) => setNullable(event.target.checked)}
          />{' '}
          Allow NULL
        </label>
        <div className="modal-actions">
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Add column
          </Button>
        </div>
      </form>
    </Modal>
  );
}
