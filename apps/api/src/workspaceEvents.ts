import { asc, eq, sql } from 'drizzle-orm';
import { db } from './db.js';
import { workspaceEvents, workspaceStreams, workspaceActivity } from './schema.js';
import {
  WORKSPACE_PROTOCOL_VERSION,
  workspaceCursorSchema,
  type WorkspaceActor,
  type WorkspaceEvent,
} from '@repellet/shared';

const RETENTION = 2000;

export async function appendWorkspaceEvent(input: {
  projectId: string;
  type: WorkspaceEvent['type'];
  payload: unknown;
  actor?: WorkspaceActor;
  action?: string;
}) {
  return db.transaction(async (tx) => {
    let [stream] = await tx
      .select()
      .from(workspaceStreams)
      .where(eq(workspaceStreams.projectId, input.projectId))
      .for('update');
    if (!stream) {
      await tx
        .insert(workspaceStreams)
        .values({ projectId: input.projectId })
        .onConflictDoNothing();
      [stream] = await tx
        .select()
        .from(workspaceStreams)
        .where(eq(workspaceStreams.projectId, input.projectId))
        .for('update');
    }
    const seq = (stream?.seq ?? 0) + 1;
    await tx
      .update(workspaceStreams)
      .set({ seq, retainedAfter: Math.max(stream?.retainedAfter ?? 0, seq - RETENTION) })
      .where(eq(workspaceStreams.projectId, input.projectId));
    const [row] = await tx
      .insert(workspaceEvents)
      .values({
        projectId: input.projectId,
        seq,
        version: WORKSPACE_PROTOCOL_VERSION,
        type: input.type,
        actor: input.actor,
        payload: input.payload,
      })
      .returning();
    // Keep the journal bounded. The event cursor remains useful until compaction.
    if (seq > RETENTION)
      await tx
        .delete(workspaceEvents)
        .where(
          sql`${workspaceEvents.projectId} = ${input.projectId} AND ${workspaceEvents.seq} <= ${seq - RETENTION}`,
        );
    if (input.action)
      await tx.insert(workspaceActivity).values({
        projectId: input.projectId,
        actor: input.actor,
        action: input.action,
        metadata: input.payload,
      });
    if (seq % 100 === 0)
      await tx.execute(sql`DELETE FROM workspace_activity WHERE project_id=${input.projectId}
        AND id NOT IN (SELECT id FROM workspace_activity WHERE project_id=${input.projectId}
          ORDER BY created_at DESC LIMIT 2000)`);
    return rowToEvent(row!);
  });
}

function rowToEvent(row: typeof workspaceEvents.$inferSelect): WorkspaceEvent {
  return {
    version: WORKSPACE_PROTOCOL_VERSION,
    seq: row.seq,
    projectId: row.projectId,
    actor: row.actor ?? undefined,
    type: row.type as WorkspaceEvent['type'],
    payload: row.payload,
  };
}

export async function workspaceCursor(projectId: string) {
  const [stream] = await db
    .select()
    .from(workspaceStreams)
    .where(eq(workspaceStreams.projectId, projectId));
  return stream?.seq ?? 0;
}

export async function replayWorkspaceEvents(projectId: string, after: number) {
  const cursor = workspaceCursorSchema.parse(after);
  const [stream] = await db
    .select()
    .from(workspaceStreams)
    .where(eq(workspaceStreams.projectId, projectId));
  const current = stream?.seq ?? 0;
  const retainedAfter = stream?.retainedAfter ?? 0;
  if (cursor > current)
    return { kind: 'resync' as const, cursor: current, reason: 'ahead' as const };
  if (cursor < retainedAfter)
    return { kind: 'resync' as const, cursor: current, reason: 'expired' as const };
  const rows = await db
    .select()
    .from(workspaceEvents)
    .where(sql`${workspaceEvents.projectId} = ${projectId} AND ${workspaceEvents.seq} > ${cursor}`)
    .orderBy(asc(workspaceEvents.seq));
  return { kind: 'events' as const, cursor: current, events: rows.map(rowToEvent) };
}

export async function workspaceActivityFeed(projectId: string, limit = 50) {
  const rows = await db
    .select()
    .from(workspaceActivity)
    .where(eq(workspaceActivity.projectId, projectId))
    .orderBy(sql`${workspaceActivity.createdAt} DESC`)
    .limit(Math.min(100, Math.max(1, limit)));
  return rows;
}
