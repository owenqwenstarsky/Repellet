import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import {
  starterCatalog,
  type Preparation,
  type AppStatus,
  type WorkflowStep,
} from '@repellet/shared';
import { db } from './db.js';
import { projects, jobs } from './schema.js';
import { bridge, workerJson } from './worker.js';
import { flushProject } from './collaboration.js';
import { serialize } from './lifecycle.js';
import { emit } from './live.js';
import { config } from './config.js';
const cancellations = new Map<string, number>();
const probes = new Map<string, string>();
export async function setPreparation(id: string, preparation: Preparation) {
  await db.update(projects).set({ preparation }).where(eq(projects.id, id));
  emit(id, { type: 'preparation', preparation });
}
export async function preparationJobs(id: string) {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.projectId, id))
    .orderBy(desc(jobs.createdAt))
    .limit(10);
}
export async function prepareProject(id: string) {
  const generation = cancellations.get(id) || 0;
  return serialize(id, async () => {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project || project.state !== 'running') throw new Error('Open the workspace first');
    const needsInstall = !!project.setupCommand.trim();
    if (!needsInstall && !project.starterId) return;
    if (!needsInstall && project.preparation.scaffolded && project.preparation.status === 'ready')
      return;
    await flushProject(id);
    if (needsInstall && project.preparation.status === 'ready') {
      const current = await bridge<{ fingerprint: string }>(id, '/fingerprint', 'POST', {
        cwd: project.runConfig.cwd,
        command: project.setupCommand,
      });
      if (current.fingerprint === project.preparation.fingerprint) return;
    }
    let preparation: Preparation = { ...project.preparation, error: null };
    const steps: WorkflowStep[] = [
      { name: 'files', startedAt: new Date().toISOString(), finishedAt: null, outcome: 'running' },
    ];
    const [job] = await db
      .insert(jobs)
      .values({
        projectId: id,
        kind: 'prepare',
        state: 'running',
        step: 'files',
        steps,
        startedAt: new Date(),
      })
      .returning();
    if (!job) throw new Error('Could not create preparation job');
    const finishStep = (outcome: WorkflowStep['outcome']) => {
      const last = steps.at(-1);
      if (last && !last.finishedAt) {
        last.finishedAt = new Date().toISOString();
        last.outcome = outcome;
      }
    };
    const update = async (step: string, log?: string) => {
      if (steps.at(-1)?.name !== step) {
        finishStep('succeeded');
        steps.push({
          name: step,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          outcome: 'running',
        });
      }
      await db
        .update(jobs)
        .set({ step, steps, ...(log === undefined ? {} : { log: log.slice(-65536) }) })
        .where(eq(jobs.id, job.id));
      emit(id, { type: 'preparation-log', jobId: job.id, step, log });
    };
    const check = () => {
      if ((cancellations.get(id) || 0) !== generation)
        throw new Error('Preparation cancelled; retry when ready');
    };
    try {
      check();
      if (project.starterId && !preparation.scaffolded) {
        preparation.status = 'files';
        await setPreparation(id, preparation);
        const directory = fileURLToPath(
          new URL(`../starters/${project.starterId}/${project.starterVersion}/`, import.meta.url),
        );
        const files: { path: string; content: string }[] = [];
        async function collect(dir: string) {
          for (const entry of await fs.readdir(path.join(directory, dir), {
            withFileTypes: true,
          })) {
            const rel = path.posix.join(dir, entry.name);
            if (entry.isDirectory()) await collect(rel);
            else
              files.push({
                path: rel,
                content: (await fs.readFile(path.join(directory, rel), 'utf8')).replaceAll(
                  '__REPELLET_PREVIEW_HOST__',
                  new URL(config.publicUrl).hostname,
                ),
              });
          }
        }
        await collect('');
        check();
        await bridge(id, '/scaffold', 'POST', { files });
        preparation.scaffolded = true;
        await setPreparation(id, preparation);
      }
      check();
      if (needsInstall) {
        const { fingerprint } = await bridge<{ fingerprint: string }>(id, '/fingerprint', 'POST', {
          cwd: project.runConfig.cwd,
          command: project.setupCommand,
        });
        if (preparation.fingerprint !== fingerprint || preparation.status !== 'ready') {
          preparation.status = 'installing';
          await setPreparation(id, preparation);
          await update('installing');
          await bridge(id, '/preparation', 'POST', {
            id: job.id,
            command: project.setupCommand,
            cwd: project.runConfig.cwd,
          });
          for (;;) {
            check();
            const status = await bridge<{ state: string; log: string; exitCode: number | null }>(
              id,
              `/preparation/${job.id}`,
            );
            await update('installing', status.log);
            if (status.state !== 'running') {
              if (status.state !== 'succeeded')
                throw new Error(
                  `Dependency installation ${status.state} (exit ${status.exitCode ?? 'unknown'}). See preparation logs.`,
                );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          check();
          preparation.fingerprint = (
            await bridge<{ fingerprint: string }>(id, '/fingerprint', 'POST', {
              cwd: project.runConfig.cwd,
              command: project.setupCommand,
            })
          ).fingerprint;
        }
      }
      finishStep('succeeded');
      preparation.status = 'ready';
      await setPreparation(id, preparation);
      await db
        .update(jobs)
        .set({ state: 'succeeded', step: 'ready', steps, finishedAt: new Date() })
        .where(eq(jobs.id, job.id));
    } catch (e) {
      finishStep((cancellations.get(id) || 0) !== generation ? 'cancelled' : 'failed');
      await bridge(id, '/preparation/cancel', 'POST').catch(() => {});
      preparation.status = (cancellations.get(id) || 0) !== generation ? 'interrupted' : 'failed';
      preparation.error = (e as Error).message;
      await setPreparation(id, preparation);
      await db
        .update(jobs)
        .set({
          state: (cancellations.get(id) || 0) !== generation ? 'cancelled' : 'failed',
          steps,
          error: preparation.error,
          finishedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
      throw e;
    }
  });
}
export async function cancelReadiness(id: string) {
  probes.delete(id);
  await setAppStatus(id, { status: 'stopped' });
}
export async function cancelProjectWork(id: string) {
  cancellations.set(id, (cancellations.get(id) || 0) + 1);
  probes.delete(id);
  await bridge(id, '/preparation/cancel', 'POST').catch(() => {});
  await cancelReadiness(id);
}
export async function setAppStatus(id: string, appStatus: AppStatus) {
  await db.update(projects).set({ appStatus }).where(eq(projects.id, id));
  emit(id, { type: 'app', appStatus });
}
export async function probePreview(id: string, port: number) {
  const generation = randomUUID();
  probes.set(id, generation);
  await setAppStatus(id, { status: 'starting', generation });
  void (async () => {
    const deadline = Date.now() + 60000;
    while (probes.get(id) === generation) {
      const result = await workerJson<{ responding: boolean; httpStatus?: number }>(
        `/projects/${id}/probe`,
        'POST',
        { port },
      ).catch(() => ({ responding: false, httpStatus: undefined }));
      if (probes.get(id) !== generation) return;
      if (result.responding) {
        await setAppStatus(id, { status: 'available', httpStatus: result.httpStatus, generation });
        probes.delete(id);
        return;
      }
      const terminals = await bridge<{ isRun: boolean; alive: boolean }[]>(id, '/terminals').catch(
        () => null,
      );
      if (probes.get(id) !== generation) return;
      if (Array.isArray(terminals) && !terminals.some((t) => t.isRun && t.alive)) {
        await setAppStatus(id, {
          status: 'failed',
          generation,
          error:
            'The app process exited before preview readiness. Check the Run terminal output, then click Run to retry.',
        });
        probes.delete(id);
        return;
      }
      if (Date.now() >= deadline) {
        await setAppStatus(id, {
          status: 'timeout',
          generation,
          error:
            'No HTTP response after 60 seconds. Check Run output, dependencies, working directory, and that the server listens on 0.0.0.0 at the configured port. The app is still running.',
        });
        probes.delete(id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })().catch((e) => emit(id, { type: 'error', message: (e as Error).message }));
}
export async function assertPrepared(id: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) throw new Error('Project not found');
  if (
    project.starterId &&
    (!project.preparation.scaffolded || !['none', 'ready'].includes(project.preparation.status))
  )
    throw Object.assign(
      new Error('Starter files need preparation. Retry preparation before Run.'),
      {
        statusCode: 409,
      },
    );
  if (project.setupCommand.trim()) {
    const { fingerprint } = await bridge<{ fingerprint: string }>(id, '/fingerprint', 'POST', {
      cwd: project.runConfig.cwd,
      command: project.setupCommand,
    });
    if (project.preparation.status !== 'ready' || project.preparation.fingerprint !== fingerprint) {
      if (project.preparation.status === 'ready')
        await setPreparation(id, {
          ...project.preparation,
          status: 'failed',
          error: 'Dependency manifests changed. Retry preparation before Run.',
        });
      throw Object.assign(
        new Error('Dependencies need preparation. Retry preparation before Run.'),
        { statusCode: 409 },
      );
    }
  }
  return project;
}
export const starterFor = (id?: string) => starterCatalog.find((s) => s.id === id);
