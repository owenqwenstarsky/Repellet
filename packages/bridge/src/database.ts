import pg from 'pg';
import Cursor from 'pg-cursor';
import { MongoClient, BSON } from './database-mongo.js';

type Connection = { id: string; type: 'postgresql' | 'mongodb'; url: string };
type Column = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  generated?: boolean;
};
type Operation = {
  operation: string;
  name?: string;
  schema?: string;
  offset?: number;
  filter?: Record<string, unknown>;
  values?: Record<string, unknown>;
  key?: Record<string, unknown>;
  column?: string;
  newName?: string;
  type?: string;
  nullable?: boolean;
  sql?: string;
  parameters?: unknown[];
  command?: Record<string, unknown>;
};
export const MAX_DATABASE_BYTES = 1024 * 1024;
export const MAX_DATABASE_ROWS = 1000;
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
export function identifier(value: string) {
  if (!value || Buffer.byteLength(value) > 63 || value.includes('\0'))
    throw fail('Invalid database identifier');
  return `"${value.replaceAll('"', '""')}"`;
}
export function requirePrimaryKey(columns: Column[], key: Record<string, unknown>) {
  const names = columns.filter((column) => column.primaryKey).map((column) => column.name);
  if (
    !names.length ||
    names.length !== Object.keys(key).length ||
    names.some((name) => !Object.hasOwn(key, name) || key[name] === null || key[name] === undefined)
  )
    throw fail(
      'A complete primary key is required. Use the console for tables without a primary key.',
    );
  return names;
}
const types = new Set([
  'text',
  'integer',
  'bigint',
  'boolean',
  'numeric',
  'double precision',
  'uuid',
  'jsonb',
  'date',
  'timestamp with time zone',
  'bytea',
]);
export function columnDefinition(column: string, type: string, nullable: boolean) {
  if (!types.has(type)) throw fail('Unsupported visual column type. Use the SQL console.');
  return `${identifier(column)} ${type}${nullable ? '' : ' NOT NULL'}`;
}
function validateConnection(connection: Connection) {
  if (
    !connection ||
    !/^[0-9a-f-]{36}$/.test(connection.id) ||
    !['postgresql', 'mongodb'].includes(connection.type)
  )
    throw fail('Invalid managed database connection');
  const url = new URL(connection.url);
  if (
    !/^repellet-database-[0-9a-f-]{36}$/.test(url.hostname) ||
    url.pathname !== '/repellet' ||
    url.username !== 'workspace' ||
    (connection.type === 'postgresql'
      ? url.protocol !== 'postgresql:'
      : url.protocol !== 'mongodb:')
  )
    throw fail('Invalid managed database connection');
}
function boundedRows(rows: Record<string, unknown>[], limit = MAX_DATABASE_ROWS) {
  const kept: Record<string, unknown>[] = [];
  let bytes = 256;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (kept.length >= limit || bytes + size > MAX_DATABASE_BYTES - 65536)
      return { rows: kept, truncated: true };
    bytes += size;
    kept.push(row);
  }
  return { rows: kept, truncated: false };
}
export function boundDatabaseResult(result: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(result)) <= MAX_DATABASE_BYTES) return result;
  return {
    truncated: true,
    result: 'Result exceeds 1 MiB. Select fewer fields or a smaller result.',
  };
}
async function pgColumns(client: pg.Client, schema: string, name: string): Promise<Column[]> {
  const result = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
    NOT a.attnotnull AS nullable, EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS "primaryKey",
    (a.attidentity<>'' OR a.attgenerated<>'') AS generated
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=$2 AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [schema, name],
  );
  if (!result.rows.length) throw fail('Table does not exist', 404);
  return result.rows as Column[];
}
export async function cursorResult(
  client: pg.Client,
  sql: string,
  parameters: unknown[],
  signal?: AbortSignal,
) {
  // pg-cursor uses the extended protocol, so a request cannot contain multiple statements.
  const cursor = client.query(new Cursor(sql, parameters));
  const rows: Record<string, unknown>[] = [];
  let bytes = 256,
    truncated = false;
  try {
    while (true) {
      signal?.throwIfAborted();
      const batch = await cursor.read(1);
      if (!batch.length) break;
      for (const row of batch) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length === MAX_DATABASE_ROWS || bytes + size > MAX_DATABASE_BYTES - 65536) {
          truncated = true;
          break;
        }
        rows.push(row);
        bytes += size;
      }
      if (truncated) break;
    }
    const command = (cursor as unknown as { _result?: { rowCount?: number; command?: string } })
      ._result;
    return { rows, affected: command?.rowCount ?? rows.length, truncated };
  } finally {
    await cursor.close().catch(() => {});
  }
}
async function postgres(connection: Connection, op: Operation, signal: AbortSignal) {
  const client = new pg.Client({
    connectionString: connection.url,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    query_timeout: 31000,
  });
  const cancel = () => {
    void client.end().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await client.connect();
    signal.throwIfAborted();
    if (op.operation === 'ping') {
      await client.query('SELECT 1');
      return { result: 'ready' };
    }
    if (op.operation === 'execute_sql')
      return await cursorResult(client, op.sql!, op.parameters || [], signal);
    if (op.operation === 'schema') {
      const tables = await client.query(
        `SELECT c.relname AS name, n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname LIMIT 1001`,
      );
      const objects = [];
      for (const table of tables.rows.slice(0, 1000)) {
        signal.throwIfAborted();
        objects.push({ ...table, columns: await pgColumns(client, table.schema, table.name) });
      }
      return boundDatabaseResult({ objects, truncated: tables.rows.length > 1000 });
    }
    const schema = op.schema || 'public',
      name = op.name!;
    if (schema === 'information_schema' || schema.startsWith('pg_'))
      throw fail('System schemas cannot be changed');
    const table = `${identifier(schema)}.${identifier(name)}`;
    if (op.operation === 'create') {
      await client.query(
        `CREATE TABLE ${table} (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY)`,
      );
      return { affected: 0 };
    }
    const columns = await pgColumns(client, schema, name);
    if (op.operation === 'read') {
      const filter = op.filter || {},
        names = Object.keys(filter);
      if (names.some((field) => !columns.some((column) => column.name === field)))
        throw fail('Unknown filter column');
      const keys = columns
        .filter((column) => column.primaryKey)
        .map((column) => identifier(column.name));
      const where = names.length
        ? ` WHERE ${names.map((field, i) => `${identifier(field)} IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')}`
        : '';
      const result = await cursorResult(
        client,
        `SELECT * FROM ${table}${where}${keys.length ? ` ORDER BY ${keys.join(',')}` : ''} LIMIT 101 OFFSET $${names.length + 1}`,
        [...names.map((field) => filter[field]), op.offset || 0],
        signal,
      );
      const bounded = boundedRows(result.rows.slice(0, 100), 100);
      return {
        ...bounded,
        columns,
        hasMore: result.rows.length > 100 || result.truncated,
        truncated: result.truncated || bounded.truncated,
      };
    }
    if (op.operation === 'drop') {
      await client.query(`DROP TABLE ${table}`);
      return { affected: 0 };
    }
    if (op.operation === 'add_column') {
      await client.query(
        `ALTER TABLE ${table} ADD COLUMN ${columnDefinition(op.column!, op.type!, !!op.nullable)}`,
      );
      return { affected: 0 };
    }
    if (op.operation === 'rename_column') {
      await client.query(
        `ALTER TABLE ${table} RENAME COLUMN ${identifier(op.column!)} TO ${identifier(op.newName!)}`,
      );
      return { affected: 0 };
    }
    if (op.operation === 'drop_column') {
      await client.query(`ALTER TABLE ${table} DROP COLUMN ${identifier(op.column!)}`);
      return { affected: 0 };
    }
    const values = op.values || {},
      fields = Object.keys(values);
    if (
      fields.some((field) => !columns.some((column) => column.name === field && !column.generated))
    )
      throw fail('Unknown or generated column');
    if (op.operation === 'insert') {
      const result = await client.query(
        fields.length
          ? `INSERT INTO ${table} (${fields.map(identifier).join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`
          : `INSERT INTO ${table} DEFAULT VALUES`,
        fields.map((field) => values[field]),
      );
      return { affected: result.rowCount || 0 };
    }
    const key = op.key || {},
      keys = requirePrimaryKey(columns, key);
    const parameters = op.operation === 'update' ? fields.map((field) => values[field]) : [];
    const where = keys
      .map((field, i) => `${identifier(field)}=$${parameters.length + i + 1}`)
      .join(' AND ');
    if (op.operation === 'update' && !fields.length) throw fail('Provide fields to update');
    const sql =
      op.operation === 'delete'
        ? `DELETE FROM ${table} WHERE ${where}`
        : op.operation === 'update'
          ? `UPDATE ${table} SET ${fields.map((field, i) => `${identifier(field)}=$${i + 1}`).join(',')} WHERE ${where}`
          : '';
    if (!sql) throw fail('Unsupported PostgreSQL operation');
    const result = await client.query(sql, [...parameters, ...keys.map((field) => key[field])]);
    return { affected: result.rowCount || 0 };
  } finally {
    signal.removeEventListener('abort', cancel);
    await client.end().catch(() => {});
  }
}
function mongoObject(value: Record<string, unknown>) {
  return BSON.EJSON.deserialize(value, { relaxed: false }) as Record<string, unknown>;
}
async function mongoRows(
  cursor: AsyncIterable<unknown> & { close: () => Promise<void> },
  limit: number,
  signal: AbortSignal,
) {
  const rows: Record<string, unknown>[] = [];
  let bytes = 256,
    truncated = false;
  try {
    for await (const document of cursor) {
      signal.throwIfAborted();
      const row = BSON.EJSON.serialize(document, { relaxed: false }) as Record<string, unknown>;
      const size = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (rows.length >= limit || bytes + size > MAX_DATABASE_BYTES - 65536) {
        truncated = true;
        break;
      }
      rows.push(row);
      bytes += size;
    }
  } finally {
    await cursor.close().catch(() => {});
  }
  return { rows, truncated };
}
async function mongodb(connection: Connection, op: Operation, signal: AbortSignal) {
  const client = new MongoClient(connection.url, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 31000,
    maxPoolSize: 1,
  });
  const cancel = () => {
    void client.close(true).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await client.connect();
    signal.throwIfAborted();
    const db = client.db('repellet');
    if (op.operation === 'ping') {
      await db.command({ ping: 1 });
      return { result: 'ready' };
    }
    if (op.operation === 'schema') {
      const result = await mongoRows(
        db.listCollections({}, { nameOnly: true, batchSize: 50 }),
        1000,
        signal,
      );
      return {
        objects: result.rows.map((row) => ({ name: row.name })),
        truncated: result.truncated,
      };
    }
    if (op.operation === 'execute_mongo') {
      const command = mongoObject(op.command || {});
      if (!Object.keys(command).length) throw fail('Provide a MongoDB command');
      if (Object.hasOwn(command, '$db') || Object.hasOwn(command, 'getMore'))
        throw fail(
          'Commands target this project database; use find or aggregate rather than getMore.',
        );
      // Override execution/batch limits regardless of caller-supplied values.
      command.maxTimeMS = 30000;
      if (Object.hasOwn(command, 'find')) {
        command.limit = Math.min(Number(command.limit) > 0 ? Number(command.limit) : 1001, 1001);
        command.batchSize = 50;
      }
      if (Object.hasOwn(command, 'aggregate')) command.cursor = { batchSize: 50 };
      const result = await db.command(command);
      if (result.cursor) {
        const first = (result.cursor.firstBatch || []).slice(0, 1001);
        const values: unknown[] = first;
        let cursorId = result.cursor.id;
        try {
          while (!BSON.Long.fromValue(cursorId).isZero() && values.length <= 1000) {
            signal.throwIfAborted();
            if (Buffer.byteLength(BSON.EJSON.stringify(values)) >= MAX_DATABASE_BYTES - 65536)
              break;
            const collection = String(result.cursor.ns).slice('repellet.'.length);
            const batch = await db.command({
              getMore: cursorId,
              collection,
              batchSize: Math.min(50, 1001 - values.length),
              maxTimeMS: 30000,
            });
            values.push(...batch.cursor.nextBatch);
            cursorId = batch.cursor.id;
          }
          const bounded = boundedRows(
            values.map(
              (value) => BSON.EJSON.serialize(value, { relaxed: false }) as Record<string, unknown>,
            ),
          );
          return {
            ...bounded,
            truncated: bounded.truncated || !BSON.Long.fromValue(cursorId).isZero(),
          };
        } finally {
          if (!BSON.Long.fromValue(cursorId).isZero())
            await db
              .command({
                killCursors: String(result.cursor.ns).slice('repellet.'.length),
                cursors: [cursorId],
              })
              .catch(() => {});
        }
      }
      return boundDatabaseResult({ result: BSON.EJSON.serialize(result, { relaxed: false }) });
    }
    const name = op.name!;
    if (!name || name.includes('\0') || name.startsWith('system.'))
      throw fail('Invalid collection name');
    const collection = db.collection<{ _id?: any; [key: string]: any }>(name);
    if (op.operation === 'read') {
      const filter = mongoObject(op.filter || {});
      if (Object.keys(filter).some((field) => field.startsWith('$') || field.includes('\0')))
        throw fail('Read filters accept field equality only');
      const equality = Object.fromEntries(
        Object.entries(filter).map(([field, value]) => [field, { $eq: value }]),
      );
      const result = await mongoRows(
        collection
          .find(equality, { maxTimeMS: 30000 })
          .sort({ _id: 1 })
          .skip(op.offset || 0)
          .limit(101)
          .batchSize(25),
        100,
        signal,
      );
      return { ...result, hasMore: result.truncated };
    }
    if (op.operation === 'create') {
      await db.createCollection(name);
      return { affected: 0 };
    }
    if (op.operation === 'drop') {
      await collection.drop();
      return { affected: 0 };
    }
    if (op.operation === 'insert') {
      await collection.insertOne(mongoObject(op.values || {}));
      return { affected: 1 };
    }
    if (op.operation === 'update' || op.operation === 'delete') {
      const key = mongoObject(op.key || {});
      if (Object.keys(key).length !== 1 || !Object.hasOwn(key, '_id') || key._id == null)
        throw fail('A document _id is required');
      if (op.operation === 'delete') {
        const result = await collection.deleteOne({ _id: { $eq: key._id } });
        return { affected: result.deletedCount };
      }
      const values = mongoObject(op.values || {});
      delete values._id;
      if (Object.keys(values).some((field) => field.startsWith('$')))
        throw fail('Document field names cannot start with $');
      const result = await collection.replaceOne(
        { _id: { $eq: key._id } },
        { ...values, _id: key._id },
      );
      return { affected: result.modifiedCount };
    }
    throw fail('Unsupported MongoDB operation');
  } finally {
    signal.removeEventListener('abort', cancel);
    await client.close().catch(() => {});
  }
}
export async function databaseOperation(
  connection: Connection,
  operation: Operation,
  external?: AbortSignal,
) {
  validateConnection(connection);
  const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(external ? [external] : [])]);
  const write = !['ping', 'schema', 'read'].includes(operation.operation);
  try {
    signal.throwIfAborted();
    if (
      (connection.type === 'postgresql' && operation.operation === 'execute_mongo') ||
      (connection.type === 'mongodb' && operation.operation === 'execute_sql')
    )
      throw fail('Command does not match database type');
    return boundDatabaseResult(
      await (connection.type === 'postgresql'
        ? postgres(connection, operation, signal)
        : mongodb(connection, operation, signal)),
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Preserve actionable statement errors without leaking the supplied URL/password.
    const message = String((error as Error).message || 'Database operation failed')
      .replaceAll(connection.url, '[connection]')
      .replaceAll(new URL(connection.url).password, '[credential]')
      .slice(0, 500);
    const uncertain =
      write &&
      !(error as { statusCode?: number }).statusCode &&
      (signal.aborted || !code || /^(08|57P)/.test(code));
    throw Object.assign(
      new Error(
        uncertain
          ? 'Database write outcome is uncertain. Inspect current data before retrying.'
          : message,
      ),
      {
        statusCode: uncertain ? 503 : (error as { statusCode?: number }).statusCode || 400,
        uncertain,
      },
    );
  }
}
