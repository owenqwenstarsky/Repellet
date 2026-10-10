import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  databaseTypeSchema,
  databaseOperationSchema,
  environmentOperationSchema,
} from '@repellet/shared';
import { requireUser, projectAccess } from './security.js';
import {
  createDatabase,
  deleteDatabase,
  databaseStatus,
  retryDatabaseWithinOperation,
  operateDatabase,
} from './databases.js';
import { changeEnvironment } from './environment.js';
import { serialize } from './lifecycle.js';

export async function databaseRoutes(app: FastifyInstance) {
  async function access(req: { params: unknown }, mode: 'manage' | 'edit') {
    const id = z
      .string()
      .uuid()
      .parse((req.params as { id: string }).id);
    await projectAccess(await requireUser(req as never), id, mode);
    return id;
  }
  app.get('/api/projects/:id/database', async (req) => databaseStatus(await access(req, 'edit')));
  app.post('/api/projects/:id/database', async (req, reply) => {
    const id = await access(req, 'manage');
    const { type } = z.object({ type: databaseTypeSchema }).strict().parse(req.body);
    return reply.code(201).send(await createDatabase(id, type));
  });
  app.delete('/api/projects/:id/database', async (req) =>
    deleteDatabase(await access(req, 'manage')),
  );
  app.post('/api/projects/:id/database/retry', async (req) => {
    const id = await access(req, 'manage');
    return serialize(id, () => retryDatabaseWithinOperation(id));
  });
  app.post('/api/projects/:id/database/operations', async (req, reply) => {
    const id = await access(req, 'edit');
    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.on('close', cancel);
    try {
      return await operateDatabase(id, databaseOperationSchema.parse(req.body), controller.signal);
    } finally {
      reply.raw.off('close', cancel);
    }
  });
  app.post('/api/projects/:id/environment/variables', async (req) =>
    changeEnvironment(await access(req, 'manage'), environmentOperationSchema.parse(req.body)),
  );
}
