import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { runProfileInputSchema } from '@repellet/shared';
import { db } from './db.js';
import {
  documents,
  projects,
  projectRunProfiles,
  projectPreviewTargets,
  workspaceProcesses,
} from './schema.js';
import { access } from './routes.js';
import { workspaceCursor, workspaceActivityFeed } from './workspaceEvents.js';
import { serialize } from './lifecycle.js';
import { emit } from './live.js';
import { startProfile, reconcileProcesses, stopProcess } from './processes.js';
import { requireUser } from './security.js';
import { bridge } from './worker.js';

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/api/projects/:id/processes', async (req) => {
    const p = await access(req);
    if (p.state === 'running') await serialize(p.id, () => reconcileProcesses(p.id));
    return db.select().from(workspaceProcesses).where(eq(workspaceProcesses.projectId, p.id));
  });
  app.post(
    '/api/projects/:id/run-profiles/:profileId/start',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const p = await access(req, 'edit');
      const actor = await requireUser(req);
      const profileId = z
        .string()
        .uuid()
        .parse((req.params as { profileId: string }).profileId);
      const { kind } = z
        .object({ kind: z.enum(['run', 'task']).default('run') })
        .strict()
        .parse(req.body ?? {});
      return serialize(p.id, async () => {
        await access(req, 'edit');
        return startProfile(p.id, profileId, actor.id, kind);
      });
    },
  );
  app.post('/api/projects/:id/processes/:processId/stop', async (req) => {
    const p = await access(req, 'edit');
    const id = z
      .string()
      .uuid()
      .parse((req.params as { processId: string }).processId);
    return serialize(p.id, async () => {
      await access(req, 'edit');
      const [process] = await db
        .select()
        .from(workspaceProcesses)
        .where(and(eq(workspaceProcesses.id, id), eq(workspaceProcesses.projectId, p.id)));
      if (!process) throw Object.assign(new Error('Process not found'), { statusCode: 404 });
      if (['starting', 'running'].includes(process.status)) {
        await stopProcess(p.id, id);
      }
      return { ok: true };
    });
  });
  app.get('/api/projects/:id/workspace', async (req) => {
    const p = await access(req);
    const [registry, profiles, previews, processes, cursor] = await Promise.all([
      db
        .select({
          id: documents.id,
          path: documents.path,
          revision: documents.revision,
          dirty: documents.dirty,
          conflict: documents.conflict,
        })
        .from(documents)
        .where(eq(documents.projectId, p.id)),
      db.select().from(projectRunProfiles).where(eq(projectRunProfiles.projectId, p.id)),
      db.select().from(projectPreviewTargets).where(eq(projectPreviewTargets.projectId, p.id)),
      db.select().from(workspaceProcesses).where(eq(workspaceProcesses.projectId, p.id)),
      workspaceCursor(p.id),
    ]);
    return {
      version: 1,
      projectId: p.id,
      cursor,
      documents: registry,
      runProfiles: profiles,
      previewTargets: previews,
      processes,
    };
  });
  app.get('/api/projects/:id/activity', async (req) => {
    const p = await access(req);
    return workspaceActivityFeed(p.id);
  });
  app.get('/api/projects/:id/run-profiles', async (req) => {
    const p = await access(req);
    return db.select().from(projectRunProfiles).where(eq(projectRunProfiles.projectId, p.id));
  });
  app.post('/api/projects/:id/run-profiles', async (req, reply) => {
    const p = await access(req, 'manage');
    const b = runProfileInputSchema.parse(req.body);
    return serialize(p.id, async () => {
      await access(req, 'manage');
      if (b.previewTargetId) await assertTarget(p.id, b.previewTargetId);
      const existing = await db
        .select({ id: projectRunProfiles.id })
        .from(projectRunProfiles)
        .where(eq(projectRunProfiles.projectId, p.id));
      if (existing.length >= 20)
        throw Object.assign(new Error('Maximum of 20 run profiles'), { statusCode: 409 });
      const [profile] = await db
        .insert(projectRunProfiles)
        .values({ projectId: p.id, ...b })
        .returning();
      await emit(p.id, { type: 'project', action: 'run-profile.created', profileId: profile!.id });
      return reply.code(201).send(profile);
    });
  });
  app.put('/api/projects/:id/run-profiles/:profileId', async (req) => {
    const p = await access(req, 'manage');
    const profileId = z
      .string()
      .uuid()
      .parse((req.params as { profileId: string }).profileId);
    const b = runProfileInputSchema.parse(req.body);
    return serialize(p.id, async () => {
      await access(req, 'manage');
      if (b.previewTargetId) await assertTarget(p.id, b.previewTargetId);
      const [profile] = await db
        .select()
        .from(projectRunProfiles)
        .where(and(eq(projectRunProfiles.projectId, p.id), eq(projectRunProfiles.id, profileId)));
      if (!profile) throw Object.assign(new Error('Run profile not found'), { statusCode: 404 });
      // The default profile remains the compatibility projection used by legacy Run.
      if (profile.isDefault && b.previewTargetId !== (profile.previewTargetId ?? undefined))
        throw Object.assign(new Error('The default Run profile must retain its App preview'), {
          statusCode: 409,
        });
      const result = await db.transaction(async (tx) => {
        const [saved] = await tx
          .update(projectRunProfiles)
          .set({ ...b, previewTargetId: b.previewTargetId ?? null })
          .where(eq(projectRunProfiles.id, profileId))
          .returning();
        if (profile.isDefault)
          await tx
            .update(projects)
            .set({
              runConfig: { ...p.runConfig, command: b.command, cwd: b.cwd },
              updatedAt: new Date(),
            })
            .where(eq(projects.id, p.id));
        return saved;
      });
      await emit(p.id, { type: 'project', action: 'run-profile.updated', profileId });
      return result;
    });
  });
  app.delete('/api/projects/:id/run-profiles/:profileId', async (req) => {
    const p = await access(req, 'manage');
    const profileId = z
      .string()
      .uuid()
      .parse((req.params as { profileId: string }).profileId);
    return serialize(p.id, async () => {
      await access(req, 'manage');
      const [profile] = await db
        .select()
        .from(projectRunProfiles)
        .where(and(eq(projectRunProfiles.projectId, p.id), eq(projectRunProfiles.id, profileId)));
      if (!profile) throw Object.assign(new Error('Run profile not found'), { statusCode: 404 });
      if (profile.isDefault)
        throw Object.assign(new Error('The default Run profile cannot be deleted'), {
          statusCode: 409,
        });
      const active = await db
        .select()
        .from(workspaceProcesses)
        .where(
          and(eq(workspaceProcesses.projectId, p.id), eq(workspaceProcesses.profileId, profileId)),
        );
      if (active.some((process) => ['starting', 'running'].includes(process.status)))
        throw Object.assign(new Error('Stop this profile before deleting it'), { statusCode: 409 });
      await db.delete(projectRunProfiles).where(eq(projectRunProfiles.id, profileId));
      await emit(p.id, { type: 'project', action: 'run-profile.deleted', profileId });
      return { ok: true };
    });
  });
}
async function assertTarget(projectId: string, id: string) {
  const [target] = await db
    .select({ id: projectPreviewTargets.id })
    .from(projectPreviewTargets)
    .where(and(eq(projectPreviewTargets.projectId, projectId), eq(projectPreviewTargets.id, id)));
  if (!target) throw Object.assign(new Error('Preview target not found'), { statusCode: 404 });
}
