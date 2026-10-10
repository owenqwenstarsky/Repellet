import { eq, sql } from 'drizzle-orm';
import { environmentSchema, type EnvironmentOperation } from '@repellet/shared';
import { db } from './db.js';
import { projects, projectDatabases, projectRunProfiles } from './schema.js';
import { decrypt, encrypt } from './security.js';
import { serialize } from './lifecycle.js';
import { bridge } from './worker.js';
import { emit } from './live.js';

import { applyEnvironmentOperation, assertManagedVariable, conflict } from './environment-rules.js';
export { conflict } from './environment-rules.js';
export async function environmentSnapshot(id: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  const [database] = await db
    .select()
    .from(projectDatabases)
    .where(eq(projectDatabases.projectId, id));
  return {
    variables: (project.environment ? JSON.parse(decrypt(project.environment)) : {}) as Record<
      string,
      string
    >,
    runtimes: project.runtimes,
    revision: project.environmentRevision,
    databaseVariableName: database?.variableName ?? null,
  };
}
/** Caller holds the project operation lock. Persistence is canonical; sync can be retried. */
export async function persistEnvironment(
  id: string,
  variables: Record<string, string>,
  renames: Record<string, string> = {},
  managedName?: string,
) {
  const validated = environmentSchema.parse(variables);
  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({ environment: encrypt(JSON.stringify(validated)), updatedAt: new Date() })
      .where(eq(projects.id, id));
    // Atomic revision increment also covers creation/deletion of the managed variable.
    await tx
      .update(projects)
      .set({ environmentRevision: sql`${projects.environmentRevision} + 1` })
      .where(eq(projects.id, id));
    if (managedName)
      await tx
        .update(projectDatabases)
        .set({ variableName: managedName })
        .where(eq(projectDatabases.projectId, id));
    if (Object.keys(renames).length) {
      const profiles = await tx
        .select()
        .from(projectRunProfiles)
        .where(eq(projectRunProfiles.projectId, id));
      for (const profile of profiles)
        await tx
          .update(projectRunProfiles)
          .set({ environmentKeys: profile.environmentKeys.map((key) => renames[key] || key) })
          .where(eq(projectRunProfiles.id, profile.id));
    }
  });
  let synced = true;
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (project?.state === 'running') {
    try {
      await bridge(id, '/environment', 'PUT', validated);
    } catch {
      synced = false;
    }
  }
  await emit(id, { type: 'environment' });
  return { ok: true, synced, revision: project?.environmentRevision };
}
export async function changeEnvironment(
  id: string,
  operation: EnvironmentOperation,
  signal?: AbortSignal,
) {
  return serialize(id, async () => {
    signal?.throwIfAborted();
    const current = await environmentSnapshot(id);
    signal?.throwIfAborted();
    const next = applyEnvironmentOperation(
      current.variables,
      operation,
      current.databaseVariableName || undefined,
    );
    const rename = operation.operation === 'rename' ? { [operation.name]: operation.newName } : {};
    return persistEnvironment(
      id,
      next,
      rename,
      operation.operation === 'rename' && operation.name === current.databaseVariableName
        ? operation.newName
        : undefined,
    );
  });
}
export async function saveEnvironment(
  id: string,
  input: {
    variables: Record<string, string>;
    revision?: number;
    databaseVariableName?: string | null;
    renames?: Record<string, string>;
  },
) {
  return serialize(id, async () => {
    const current = await environmentSnapshot(id);
    if (input.revision !== undefined && input.revision !== current.revision)
      throw conflict('Variables changed since you opened settings. Reload before saving.');
    const next = environmentSchema.parse(input.variables);
    const managed = current.databaseVariableName || undefined;
    const newManaged = input.databaseVariableName ?? managed;
    assertManagedVariable(current.variables, next, managed, newManaged);
    const renames = input.renames || {};
    for (const [from, to] of Object.entries(renames)) {
      if (
        !Object.hasOwn(current.variables, from) ||
        !Object.hasOwn(next, to) ||
        (from !== to && (Object.hasOwn(next, from) || Object.hasOwn(current.variables, to)))
      )
        throw conflict('Invalid variable rename. Reload before saving.');
    }
    if (managed && newManaged && managed !== newManaged) renames[managed] = newManaged;
    return persistEnvironment(id, next, renames, newManaged);
  });
}
