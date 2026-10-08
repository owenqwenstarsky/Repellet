import { eq, and, inArray } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { db } from './db.js';
import { projects, installation, jobs, users } from './schema.js';
import { config } from './config.js';
import { decrypt } from './security.js';
import { workerJson, bridge } from './worker.js';
import { emit, hasClients, closeProject } from './live.js';
import { flushProject, closeDocuments, externalChange } from './collaboration.js';
import type { Runtime, Limits } from '@repellet/shared';
import { cloneGithub } from './github.js';
import {
  prepareProject,
  cancelProjectWork,
  setPreparation,
  setAppStatus,
  mainRunProcessIds,
} from './preparation.js';
import { WorkspaceQueue } from './workspaceQueue.js';
import {
  autoStartProfiles,
  recordProcess,
  finishWorkspaceProcesses,
  reconcileProcesses,
} from './processes.js';
const operations = new WorkspaceQueue();
const watchers = new Map<string, WebSocket>();
export async function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return operations.run(id, fn);
}
export async function limits() {
  const [row] = await db.select().from(installation).where(eq(installation.id, 1));
  if (!row) throw new Error('Installation not initialized');
  return row.limits;
}
export async function setState(
  id: string,
  state: typeof projects.$inferSelect.state,
  error: string | null = null,
) {
  await db.update(projects).set({ state, error, updatedAt: new Date() }).where(eq(projects.id, id));
  await emit(id, { type: 'state', state, error });
}
export async function watch(id: string) {
  if (watchers.get(id)?.readyState === 1) return;
  watchers.get(id)?.close();
  const ws = new WebSocket(
    `${config.workerUrl.replace(/^http/, 'ws')}/projects/${id}/ws?path=${encodeURIComponent('/events')}`,
    { headers: { authorization: `Bearer ${config.workerToken}` } },
  );
  watchers.set(id, ws);
  ws.on('message', (raw) => {
    try {
      const event = JSON.parse(String(raw));
      if (event.type === 'process') void recordProcess(id, event.process).catch(() => {});
      else emit(id, event);
      if (event.type === 'file')
        void externalChange(id, event.path).catch((e) =>
          emit(id, { type: 'error', message: e.message }),
        );
    } catch {}
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    if (watchers.get(id) === ws) watchers.delete(id);
  });
}
export async function ensureProject(
  id: string,
  changes?: { runtimes?: Runtime[]; environment?: Record<string, string> },
) {
  if (changes) await cancelProjectWork(id);
  return serialize(id, async () => {
    let [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) throw new Error('Project not found');
    const [install] = await db.select().from(installation).where(eq(installation.id, 1));
    if (install?.maintenance) throw new Error('Installation is paused for maintenance');
    const currentLimits = await limits();
    if (project.state === 'running' && !changes) {
      const status = await workerJson<{ running: boolean }>(`/projects/${id}`);
      if (status.running) {
        await watch(id);
        await db.update(projects).set({ lastActiveAt: new Date() }).where(eq(projects.id, id));
        return;
      }
    }
    await db.transaction(async (tx) => {
      await tx.execute(`SELECT pg_advisory_xact_lock(hashtext('${project.ownerId}'))`);
      const active = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.ownerId, project.ownerId),
            inArray(projects.state, ['building', 'starting', 'running']),
          ),
        );
      if (active.filter((p) => p.id !== id).length >= currentLimits.maxActiveProjects)
        throw Object.assign(
          new Error('Active project limit reached. Stop another project first.'),
          { statusCode: 409 },
        );
      await tx
        .update(projects)
        .set({ state: 'building', error: null, updatedAt: new Date() })
        .where(eq(projects.id, id));
    });
    emit(id, { type: 'state', state: 'building' });
    const [job] = await db
      .insert(jobs)
      .values({
        projectId: id,
        kind: changes?.runtimes ? 'rebuild' : 'start',
        state: 'running',
        startedAt: new Date(),
      })
      .returning();
    try {
      if (changes && project.state === 'running') {
        await flushProject(id);
        await closeDocuments(id);
        closeProject(id, 'Environment rebuilding');
        watchers.get(id)?.close();
      }
      await workerJson(`/projects/${id}/build`, 'POST', {
        runtimes: changes?.runtimes || project.runtimes,
        rebuild: !!changes?.runtimes,
      });
      await setState(id, 'starting');
      const environment =
        changes?.environment ||
        (project.environment ? JSON.parse(decrypt(project.environment)) : {});
      const usage = await workerJson<{ storageBytes: number; storageExceeded: boolean }>(
        `/projects/${id}/ensure`,
        'POST',
        {
          runtimes: changes?.runtimes || project.runtimes,
          limits: currentLimits,
          environment,
          rebuild: !!changes?.runtimes,
          prepared: true,
          cloneUrl: project.cloneUrl,
          previewTargetPort: project.runConfig.port,
        },
      );
      await cloneGithub(project);
      const preview = await workerJson<{ port: number }>(`/projects/${id}/preview`, 'POST', {
        targetPort: project.runConfig.port,
        port: project.previewPort,
      });
      await db
        .update(projects)
        .set({
          ...(changes?.runtimes ? { runtimes: changes.runtimes } : {}),
          storageBytes: usage.storageBytes,
          storageExceeded: usage.storageExceeded,
          previewPort: preview.port,
          cloneUrl: null,
          lastActiveAt: new Date(),
        })
        .where(eq(projects.id, id));
      await setState(id, 'running');
      if (job)
        await db
          .update(jobs)
          .set({ state: 'succeeded', finishedAt: new Date() })
          .where(eq(jobs.id, job.id));
      await watch(id);
      await autoStartProfiles(id).catch((error) =>
        emit(id, { type: 'error', message: `Automatic Run failed: ${(error as Error).message}` }),
      );
    } catch (e) {
      await setState(id, 'failed', (e as Error).message);
      if (job)
        await db
          .update(jobs)
          .set({ state: 'failed', error: (e as Error).message, finishedAt: new Date() })
          .where(eq(jobs.id, job.id));
      throw e;
    }
  });
}
export async function stopProject(id: string) {
  await cancelProjectWork(id);
  return serialize(id, () => stopProjectWithinOperation(id));
}
// Caller must hold the project's operation lock. Public stop cancels before waiting for it.
export async function stopProjectWithinOperation(id: string) {
  try {
    await flushProject(id);
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode !== 409) throw e;
  }
  await setState(id, 'stopping');
  await closeDocuments(id);
  watchers.get(id)?.close();
  closeProject(id);
  try {
    await workerJson(`/projects/${id}/stop`, 'POST');
    await finishWorkspaceProcesses(id);
    await setState(id, 'stopped');
  } catch (e) {
    await setState(id, 'failed', (e as Error).message);
    throw e;
  }
}

export async function reconcile() {
  const all = await db.select().from(projects);
  await db
    .update(jobs)
    .set({
      state: 'failed',
      error: 'Server restarted during operation; retry from the workspace',
      finishedAt: new Date(),
    })
    .where(inArray(jobs.state, ['pending', 'running']));
  for (const p of all) {
    if (['files', 'installing'].includes(p.preparation.status)) {
      await cancelProjectWork(p.id);
      await setPreparation(p.id, {
        ...p.preparation,
        status: 'interrupted',
        error: 'Server restarted during preparation. Retry when ready.',
      });
    }
    try {
      const state = await workerJson<{ running: boolean; oomKilled: boolean }>(`/projects/${p.id}`);
      if (state.running) {
        await reconcileProcesses(p.id).catch(() => {}); // Older bridges upgrade on rebuild.
        await db
          .update(projects)
          .set({ state: 'running', error: null })
          .where(eq(projects.id, p.id));
        const preview = await workerJson<{ port: number }>(`/projects/${p.id}/preview`, 'POST', {
          targetPort: p.runConfig.port,
          port: p.previewPort,
        });
        await db.update(projects).set({ previewPort: preview.port }).where(eq(projects.id, p.id));
        await watch(p.id);
        if (p.appStatus.status === 'starting')
          await setAppStatus(p.id, {
            status: 'timeout',
            error:
              'Readiness checking was interrupted by a restart. Retry readiness to check the running app.',
          });
      } else {
        await finishWorkspaceProcesses(p.id);
        if (p.state !== 'stopped')
          await setState(
            p.id,
            state.oomKilled ? 'failed' : 'stopped',
            state.oomKilled ? 'Workspace exceeded its memory limit' : null,
          );
      }
    } catch (e) {
      console.error('Reconciliation failed', p.id, (e as Error).message);
    }
  }
}
let monitoring = false;
export async function monitor() {
  if (monitoring) return;
  monitoring = true;
  try {
    const currentLimits = await limits();
    const active = await db.select().from(projects).where(eq(projects.state, 'running'));
    for (const p of active) {
      // Dependency installation holds the project operation lock, but still needs quota checks.
      if (operations.has(p.id) && !['files', 'installing'].includes(p.preparation.status)) continue;
      try {
        const status = await workerJson<{ running: boolean; oomKilled: boolean }>(
          `/projects/${p.id}`,
        );
        if (!status.running) {
          await finishWorkspaceProcesses(p.id);
          await setState(
            p.id,
            'failed',
            status.oomKilled
              ? 'Workspace exceeded its memory limit'
              : 'Workspace container stopped unexpectedly',
          );
          closeProject(p.id);
          continue;
        }
        if (['available', 'starting', 'timeout'].includes(p.appStatus.status)) {
          const mainIds = await mainRunProcessIds(p.id);
          const terminals = await bridge<{ id?: string; isRun: boolean; alive: boolean }[]>(
            p.id,
            '/terminals',
          );
          if (!terminals.some((t) => (!t.id || mainIds.has(t.id)) && t.isRun && t.alive))
            await setAppStatus(p.id, {
              status: 'failed',
              error: 'The app process exited. Check the Run terminal, then click Run to retry.',
            });
        }
        const usage = await workerJson<{ bytes: number; exceeded: boolean }>(
          `/projects/${p.id}/agent/usage`,
        );
        await db
          .update(projects)
          .set({ storageBytes: usage.bytes, storageExceeded: usage.exceeded })
          .where(eq(projects.id, p.id));
        emit(p.id, { type: 'storage', bytes: usage.bytes, exceeded: usage.exceeded });
        if (operations.has(p.id)) continue;
        const agent = await workerJson<{ executing: boolean }>(`/projects/${p.id}/agent/activity`);
        if (hasClients(p.id) || agent.executing)
          await db.update(projects).set({ lastActiveAt: new Date() }).where(eq(projects.id, p.id));
        else if (Date.now() - p.lastActiveAt.getTime() > currentLimits.idleMinutes * 60000)
          await stopProject(p.id);
        if (!watchers.has(p.id)) await watch(p.id);
      } catch (e) {
        console.error('Workspace monitoring failed', p.id, (e as Error).message);
      }
    }
  } finally {
    monitoring = false;
  }
}
