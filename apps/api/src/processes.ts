import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db.js';
import { workspaceProcesses, projectRunProfiles, projects } from './schema.js';
import { bridge } from './worker.js';
import { flushProject } from './collaboration.js';
import { emit } from './live.js';
import { assertPrepared } from './preparation.js';
const processInfo = z.object({
  id: z.string().uuid(),
  kind: z.enum(['run', 'task', 'terminal']),
  status: z.enum(['running', 'exited', 'failed', 'stopped']),
  pid: z.number().int().positive(),
  exitCode: z.number().int().optional(),
  actorId: z.string().uuid().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
});
export async function recordProcess(projectId: string, input: unknown) {
  const parsed = processInfo.safeParse(input);
  if (!parsed.success) return; // Legacy Run has a non-UUID session identifier.
  const p = parsed.data;
  const [existing] = await db
    .select()
    .from(workspaceProcesses)
    .where(and(eq(workspaceProcesses.projectId, projectId), eq(workspaceProcesses.id, p.id)));
  if (!existing) return; // Only the control plane creates process identities.
  if (!['starting', 'running'].includes(existing.status)) return;
  if (
    existing.status === p.status &&
    existing.pid === p.pid &&
    existing.exitCode === (p.exitCode ?? null)
  )
    return;
  await db
    .update(workspaceProcesses)
    .set({
      status: p.status,
      pid: p.pid,
      exitCode: p.exitCode,
      startedAt: new Date(p.startedAt),
      finishedAt: p.finishedAt ? new Date(p.finishedAt) : null,
    })
    .where(
      and(
        eq(workspaceProcesses.id, p.id),
        inArray(workspaceProcesses.status, ['starting', 'running']),
      ),
    );
  await emit(projectId, { type: 'process', process: p });
}
export async function reconcileProcesses(projectId: string) {
  const live = await bridge<unknown[]>(projectId, '/processes');
  const records = await db
    .select()
    .from(workspaceProcesses)
    .where(
      and(
        eq(workspaceProcesses.projectId, projectId),
        inArray(workspaceProcesses.status, ['starting', 'running']),
      ),
    );
  const byId = new Map(live.map((p) => [String((p as { id: string }).id), p]));
  for (const p of records) {
    if (byId.has(p.id)) await recordProcess(projectId, byId.get(p.id));
    else if (p.status !== 'starting' || Date.now() - p.createdAt.getTime() > 240000) {
      await db
        .update(workspaceProcesses)
        .set({ status: 'failed', finishedAt: new Date() })
        .where(eq(workspaceProcesses.id, p.id));
      await emit(projectId, {
        type: 'process',
        process: {
          id: p.id,
          status: 'failed',
          reason: 'Process did not survive workspace replacement',
        },
      });
    }
  }
}
export async function finishWorkspaceProcesses(projectId: string) {
  await db
    .update(workspaceProcesses)
    .set({ status: 'stopped', finishedAt: new Date() })
    .where(
      and(
        eq(workspaceProcesses.projectId, projectId),
        inArray(workspaceProcesses.status, ['starting', 'running']),
      ),
    );
}
export async function startProfile(
  projectId: string,
  profileId: string,
  actorId?: string,
  kind: 'run' | 'task' = 'run',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (project?.state !== 'running')
    throw Object.assign(new Error('Start the workspace first'), { statusCode: 409 });
  if (project.storageExceeded)
    throw Object.assign(new Error('Project storage limit reached'), { statusCode: 507 });
  const [profile] = await db
    .select()
    .from(projectRunProfiles)
    .where(and(eq(projectRunProfiles.projectId, projectId), eq(projectRunProfiles.id, profileId)));
  if (!profile) throw Object.assign(new Error('Run profile not found'), { statusCode: 404 });
  if (!profile.command.trim())
    throw Object.assign(new Error('Set a command first'), { statusCode: 400 });
  signal?.throwIfAborted();
  if (profile.isDefault) await bridge(projectId, '/run/stop', 'POST');
  const health = await bridge<{ protocolVersion?: number; capabilities?: string[] }>(
    projectId,
    '/health',
  );
  if (health.protocolVersion !== 1 || !health.capabilities?.includes('processes'))
    throw Object.assign(new Error('Rebuild the workspace to use run profiles'), {
      statusCode: 409,
    });
  await reconcileProcesses(projectId);
  const [active] = await db
    .select()
    .from(workspaceProcesses)
    .where(
      and(
        eq(workspaceProcesses.projectId, projectId),
        eq(workspaceProcesses.profileId, profileId),
        inArray(workspaceProcesses.status, ['starting', 'running']),
      ),
    );
  if (active) return active;
  await flushProject(projectId);
  await assertPrepared(projectId);
  signal?.throwIfAborted();
  const [record] = await db
    .insert(workspaceProcesses)
    .values({ projectId, profileId, kind, status: 'starting', actorId })
    .returning();
  await emit(projectId, { type: 'process', process: record });
  let spawnRequested = false;
  try {
    signal?.throwIfAborted();
    spawnRequested = true;
    const result = await bridge(projectId, '/processes', 'POST', {
      id: record!.id,
      name: profile.name,
      command: profile.command,
      cwd: profile.cwd,
      kind,
      actorId,
      ...(profile.isDefault ? {} : { environmentKeys: profile.environmentKeys }),
    });
    await recordProcess(projectId, result);
    await db.execute(sql`DELETE FROM workspace_processes WHERE project_id=${projectId} AND status NOT IN ('starting','running')
      AND id NOT IN (SELECT id FROM workspace_processes WHERE project_id=${projectId} ORDER BY created_at DESC LIMIT 200)`);
    const [current] = await db
      .select()
      .from(workspaceProcesses)
      .where(eq(workspaceProcesses.id, record!.id));
    return current!;
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (!spawnRequested || (statusCode && statusCode >= 400 && statusCode < 500)) {
      await db
        .update(workspaceProcesses)
        .set({ status: 'failed', finishedAt: new Date() })
        .where(eq(workspaceProcesses.id, record!.id));
      await emit(projectId, { type: 'process', process: { id: record!.id, status: 'failed' } });
      throw error;
    }
    // The bridge may have spawned successfully before a transport failure. Reconciliation
    // resolves this record; never issue another spawn with a fresh ID automatically.
    await emit(projectId, {
      type: 'process',
      process: {
        id: record!.id,
        status: 'starting',
        reason: 'Refresh process status to reconcile the start outcome',
      },
    });
    throw error;
  }
}
export async function autoStartProfiles(projectId: string) {
  const profiles = await db
    .select()
    .from(projectRunProfiles)
    .where(
      and(eq(projectRunProfiles.projectId, projectId), eq(projectRunProfiles.autoStart, true)),
    );
  for (const profile of profiles) await startProfile(projectId, profile.id);
}

export async function stopProcess(projectId: string, id: string) {
  const health = await bridge<{ capabilities?: string[] }>(projectId, '/health');
  if (health.capabilities?.includes('process-stop'))
    await bridge(projectId, `/processes/${id}/stop`, 'POST');
  else await bridge(projectId, `/terminals/${id}`, 'DELETE');
  await reconcileProcesses(projectId);
  await db
    .update(workspaceProcesses)
    .set({ status: 'stopped', finishedAt: new Date() })
    .where(
      and(
        eq(workspaceProcesses.projectId, projectId),
        eq(workspaceProcesses.id, id),
        inArray(workspaceProcesses.status, ['starting', 'running']),
      ),
    );
}
