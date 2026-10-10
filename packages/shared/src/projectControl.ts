import { z } from 'zod';

export const projectControlInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), arguments: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('start'), arguments: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('stop'), arguments: z.object({}).strict() }).strict(),
  z
    .object({
      operation: z.literal('logs'),
      arguments: z.object({ tailLines: z.number().int().min(1).max(1000).optional() }).strict(),
    })
    .strict(),
]);

/** The wire request is flat; validate identity and operation without accepting extra fields. */
export function parseProjectControlRequest(input: unknown) {
  const {
    threadId,
    turnId,
    operation,
    arguments: args,
    ...extra
  } = z
    .object({
      threadId: z.string().min(1).max(200),
      turnId: z.string().min(1).max(200),
      operation: z.unknown(),
      arguments: z.unknown(),
    })
    .passthrough()
    .parse(input);
  return {
    threadId,
    turnId,
    ...projectControlInputSchema.parse({ operation, arguments: args, ...extra }),
  };
}

export const projectControlApiSchema = z
  .object({
    projectId: z.string().uuid(),
    userId: z.string().uuid(),
    control: projectControlInputSchema,
  })
  .strict();
