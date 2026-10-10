import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  resourceControlSchema,
  environmentOperationSchema,
  databaseOperationSchema,
  resourceWriteOperations,
} from '@repellet/shared';
import type { ResourceControlResult } from '@repellet/agent-protocol';
import { db } from './db.js';
import { users, installation } from './schema.js';
import { projectAgentAccess, tokenMatches } from './security.js';
import { config } from './config.js';
import { environmentSnapshot, changeEnvironment } from './environment.js';
import { databaseStatus, operateDatabase } from './databases.js';
import { workspaceContext } from './workspaceContext.js';

export async function resourceControl(
  projectId: string,
  userId: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<ResourceControlResult> {
  let mutation = false;
  try {
    const control = resourceControlSchema.parse(input);
    const args = control.arguments as Record<string, unknown>;
    signal?.throwIfAborted();
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw Object.assign(new Error('Owner access required'), { statusCode: 403 });
    await projectAgentAccess(user, projectId);
    const context = workspaceContext.getStore();
    if (context) {
      context.projectId = projectId;
      context.actor = { id: user.id, name: user.displayName, role: 'owner' };
    }
    const write = (resourceWriteOperations as readonly string[]).includes(control.operation);
    if (write) {
      const [settings] = await db.select().from(installation).where(eq(installation.id, 1));
      if (settings?.maintenance)
        return {
          error: { code: 'maintenance', message: 'Installation is paused for maintenance.' },
        };
    }
    if (control.operation === 'database_status') return { data: await databaseStatus(projectId) };
    if (
      control.operation === 'database_schema' ||
      control.operation === 'database_read' ||
      control.operation === 'database_execute'
    ) {
      const operation =
        control.operation === 'database_schema'
          ? { operation: 'schema' }
          : control.operation === 'database_read'
            ? { operation: 'read', ...args }
            : Object.hasOwn(args, 'sql')
              ? { operation: 'execute_sql', ...args }
              : { operation: 'execute_mongo', ...args };
      mutation = write;
      return {
        data: await operateDatabase(projectId, databaseOperationSchema.parse(operation), signal),
      };
    }
    if (!write) {
      const environment = await environmentSnapshot(projectId);
      if (control.operation === 'environment_sync') return { data: environment.variables };
      if (control.operation === 'environment_list')
        return {
          data: {
            names: Object.keys(environment.variables),
            databaseVariableName: environment.databaseVariableName,
          },
        };
      if (!Object.hasOwn(environment.variables, String(args.name)))
        return { error: { code: 'not_found', message: 'Variable does not exist.' } };
      return {
        data: {
          name: args.name,
          value: environment.variables[String(args.name)],
          managed: args.name === environment.databaseVariableName,
        },
      };
    }
    signal?.throwIfAborted();
    mutation = true;
    return {
      data: await changeEnvironment(
        projectId,
        environmentOperationSchema.parse({
          operation: control.operation.replace('environment_', ''),
          ...args,
        }),
        signal,
      ),
    };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    const uncertain =
      mutation &&
      (signal?.aborted ||
        status === 503 ||
        (status === undefined && !(error instanceof z.ZodError)));
    return {
      error: {
        code:
          status === 401 || status === 403
            ? 'access_denied'
            : uncertain
              ? 'uncertain'
              : 'operation_failed',
        message:
          status === 401 || status === 403
            ? 'Enabled project owner access is required.'
            : uncertain
              ? 'The write outcome is uncertain. Inspect current state before retrying.'
              : status && status < 500
                ? (error as Error).message.slice(0, 500)
                : 'Resource operation could not complete.',
        ...(uncertain ? { uncertain: true } : {}),
      },
    };
  }
}
export async function resourceControlRoutes(app: FastifyInstance) {
  app.post('/internal/agent/resource-control', async (req, reply) => {
    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, '') || '', config.workerToken))
      return reply.code(401).send({ error: 'Unauthorized' });
    const { projectId, userId, control } = z
      .object({
        projectId: z.string().uuid(),
        userId: z.string().uuid(),
        control: resourceControlSchema,
      })
      .strict()
      .parse(req.body);
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on('close', cancel);
    try {
      return await resourceControl(projectId, userId, control, controller.signal);
    } finally {
      reply.raw.off('close', cancel);
    }
  });
}
