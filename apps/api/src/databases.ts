import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  databaseOperationSchema,
  type DatabaseOperation,
  type DatabaseResult,
  type DatabaseStatus,
  type DatabaseType,
} from '@repellet/shared';
import { db } from './db.js';
import { projects, projectDatabases } from './schema.js';
import { decrypt, encrypt } from './security.js';
import { serialize } from './lifecycle.js';
import { bridge, workerJson } from './worker.js';
import { environmentSnapshot, persistEnvironment, conflict } from './environment.js';
import { emit } from './live.js';

export async function databaseRecord(id: string) {
  const [database] = await db
    .select()
    .from(projectDatabases)
    .where(eq(projectDatabases.projectId, id));
  return database;
}
export function databaseSpec(record: NonNullable<Awaited<ReturnType<typeof databaseRecord>>>) {
  return {
    id: record.id,
    type: record.type,
    image: record.image,
    initialize: !record.initialized,
    ...JSON.parse(decrypt(record.credentials)),
  };
}
export function connectionUrl(
  id: string,
  record: NonNullable<Awaited<ReturnType<typeof databaseRecord>>>,
) {
  const { password } = databaseSpec(record);
  return record.type === 'postgresql'
    ? `postgresql://workspace:${password}@repellet-database-${id}:5432/repellet`
    : `mongodb://workspace:${password}@repellet-database-${id}:27017/repellet?authSource=repellet`;
}
export async function databaseStatus(id: string): Promise<DatabaseStatus | null> {
  const record = await databaseRecord(id);
  if (!record) return null;
  const {
    credentials: _credentials,
    projectId: _project,
    createdAt: _created,
    initialized: _initialized,
    ...status
  } = record;
  return status;
}
export async function setDatabaseState(
  id: string,
  status: DatabaseStatus['status'],
  error: string | null = null,
) {
  await db
    .update(projectDatabases)
    .set({ status, error, ...(status === 'ready' ? { initialized: true } : {}) })
    .where(eq(projectDatabases.projectId, id));
  await emit(id, { type: 'database' });
}
export async function retryDatabaseWithinOperation(id: string) {
  const database = await databaseRecord(id);
  if (!database || database.status === 'deleting')
    throw conflict('No database is available to start');
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (project?.state !== 'running')
    throw conflict('Start the workspace before retrying the database.');
  await setDatabaseState(id, 'creating');
  try {
    await workerJson(`/projects/${id}/database/ensure`, 'POST', databaseSpec(database));
    const environment = await environmentSnapshot(id);
    await bridge(id, '/environment', 'PUT', environment.variables);
    await setDatabaseState(id, 'ready');
  } catch {
    await setDatabaseState(
      id,
      'failed',
      'Database could not start. Retry or delete it from the Database tab.',
    );
  }
  return databaseStatus(id);
}
export async function createDatabase(id: string, type: DatabaseType) {
  return serialize(id, async () => {
    if (await databaseRecord(id))
      throw conflict('This project already has a database. Delete it first.');
    const current = await environmentSnapshot(id);
    if (Object.hasOwn(current.variables, 'DATABASE_URL'))
      throw conflict(
        'Rename or remove the existing DATABASE_URL variable before creating a database.',
      );
    if (Object.keys(current.variables).length >= 100)
      throw conflict('Remove an environment variable to make room for DATABASE_URL.');
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (project?.state !== 'running')
      throw conflict('Start the workspace before creating a database.');
    if (project.storageExceeded)
      throw Object.assign(new Error('Project storage limit reached'), { statusCode: 507 });
    const credentials = encrypt(
      JSON.stringify({
        password: randomBytes(32).toString('hex'),
        adminPassword: randomBytes(32).toString('hex'),
      }),
    );
    const record = await db.transaction(async (tx) => {
      const [record] = await tx
        .insert(projectDatabases)
        .values({
          projectId: id,
          id: randomUUID(),
          type,
          image: type === 'postgresql' ? 'postgres:17-alpine' : 'mongo:8.0',
          credentials,
          variableName: 'DATABASE_URL',
          status: 'creating',
        })
        .returning();
      await tx
        .update(projects)
        .set({
          environment: encrypt(
            JSON.stringify({ ...current.variables, DATABASE_URL: connectionUrl(id, record!) }),
          ),
          environmentRevision: sql`${projects.environmentRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, id));
      return record!;
    });
    // Metadata and the protected connection variable survive interrupted initialization together.
    await persistEnvironment(id, { ...current.variables, DATABASE_URL: connectionUrl(id, record) });
    return retryDatabaseWithinOperation(id);
  });
}
export async function deleteDatabase(id: string) {
  return serialize(id, async () => {
    const record = await databaseRecord(id);
    if (!record) return { ok: true };
    await setDatabaseState(id, 'deleting');
    try {
      await workerJson(`/projects/${id}/database`, 'DELETE');
      const environment = await environmentSnapshot(id);
      delete environment.variables[record.variableName];
      await persistEnvironment(id, environment.variables);
      await db.delete(projectDatabases).where(eq(projectDatabases.projectId, id));
      await emit(id, { type: 'database' });
      return { ok: true };
    } catch {
      await setDatabaseState(
        id,
        'deleting',
        'Deletion is incomplete. Retry deletion before creating another database.',
      );
      throw Object.assign(
        new Error('Database deletion is incomplete. Refresh and retry deletion.'),
        { statusCode: 503 },
      );
    }
  });
}
/** Shared by browser operations and agent tools, with no caller-selected connection. */
export async function operateDatabase(
  id: string,
  input: DatabaseOperation,
  signal?: AbortSignal,
): Promise<DatabaseResult> {
  return serialize(id, async () => {
    signal?.throwIfAborted();
    const operation = databaseOperationSchema.parse(input);
    const record = await databaseRecord(id);
    if (!record || record.status !== 'ready')
      throw conflict('Database is not ready. Open the Database tab to create or retry it.');
    const health = await bridge<{ capabilities?: string[] }>(id, '/health');
    if (!health.capabilities?.includes('database'))
      throw conflict(
        'Stop and start the workspace, or rebuild its environment, to enable database tools.',
      );
    const write = !['schema', 'read'].includes(operation.operation);
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (
      project?.storageExceeded &&
      write &&
      !['delete', 'drop', 'drop_column', 'execute_sql', 'execute_mongo'].includes(
        operation.operation,
      )
    )
      throw Object.assign(new Error('Project storage limit reached'), { statusCode: 507 });
    signal?.throwIfAborted();
    const result = await bridge<DatabaseResult>(
      id,
      '/database',
      'POST',
      { database: { id: record.id, type: record.type, url: connectionUrl(id, record) }, operation },
      signal,
    );
    if (write) await emit(id, { type: 'database' });
    return result;
  });
}
