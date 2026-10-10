import { z } from 'zod';

export const databaseTypeSchema = z.enum(['postgresql', 'mongodb']);
export type DatabaseType = z.infer<typeof databaseTypeSchema>;
export type DatabaseStatus = {
  id: string;
  type: DatabaseType;
  image: string;
  variableName: string;
  status: 'creating' | 'ready' | 'stopped' | 'failed' | 'deleting';
  error: string | null;
};
export type DatabaseColumn = {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  generated?: boolean;
};
export type DatabaseResult = {
  objects?: Array<{ name: string; schema?: string; columns?: DatabaseColumn[] }>;
  rows?: Record<string, unknown>[];
  columns?: DatabaseColumn[];
  affected?: number;
  result?: unknown;
  truncated?: boolean;
  hasMore?: boolean;
};
const name = z
  .string()
  .min(1)
  .max(63)
  .refine((v) => !v.includes('\0'), 'Invalid database identifier');
const values = z
  .record(z.string(), z.unknown())
  .refine((v) => Object.keys(v).length <= 100, 'At most 100 fields');
const target = { name, schema: name.optional() };
export const databaseColumnTypeSchema = z.enum([
  'text',
  'integer',
  'bigint',
  'boolean',
  'numeric',
  'double precision',
  'uuid',
  'jsonb',
  'date',
  'timestamp with time zone',
  'bytea',
]);
export const databaseOperationSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('schema') }).strict(),
  z
    .object({
      operation: z.literal('read'),
      ...target,
      offset: z.number().int().min(0).max(1000000).default(0),
      filter: values.optional(),
    })
    .strict(),
  z.object({ operation: z.literal('insert'), ...target, values }).strict(),
  z.object({ operation: z.literal('update'), ...target, key: values, values }).strict(),
  z.object({ operation: z.literal('delete'), ...target, key: values }).strict(),
  z.object({ operation: z.literal('create'), ...target }).strict(),
  z.object({ operation: z.literal('drop'), ...target }).strict(),
  z
    .object({
      operation: z.literal('add_column'),
      ...target,
      column: name,
      type: databaseColumnTypeSchema,
      nullable: z.boolean(),
    })
    .strict(),
  z
    .object({ operation: z.literal('rename_column'), ...target, column: name, newName: name })
    .strict(),
  z.object({ operation: z.literal('drop_column'), ...target, column: name }).strict(),
  z
    .object({
      operation: z.literal('execute_sql'),
      sql: z.string().min(1).max(65536),
      parameters: z.array(z.unknown()).max(100).default([]),
    })
    .strict(),
  z.object({ operation: z.literal('execute_mongo'), command: values }).strict(),
]);
export type DatabaseOperation = z.infer<typeof databaseOperationSchema>;
export const resourceReadOperations = [
  'database_status',
  'database_schema',
  'database_read',
  'environment_list',
  'environment_get',
  'environment_sync',
] as const;
export const resourceWriteOperations = [
  'database_execute',
  'environment_create',
  'environment_update',
  'environment_rename',
  'environment_delete',
] as const;
const variable = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .max(128);
export const environmentOperationSchema = z.discriminatedUnion('operation', [
  z
    .object({ operation: z.literal('create'), name: variable, value: z.string().max(32768) })
    .strict(),
  z
    .object({ operation: z.literal('update'), name: variable, value: z.string().max(32768) })
    .strict(),
  z.object({ operation: z.literal('rename'), name: variable, newName: variable }).strict(),
  z.object({ operation: z.literal('delete'), name: variable }).strict(),
]);
export type EnvironmentOperation = z.infer<typeof environmentOperationSchema>;
export const resourceControlSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('database_status'), arguments: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('database_schema'), arguments: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('environment_list'), arguments: z.object({}).strict() }).strict(),
  z.object({ operation: z.literal('environment_sync'), arguments: z.object({}).strict() }).strict(),
  z
    .object({
      operation: z.literal('database_read'),
      arguments: z
        .object({
          ...target,
          offset: z.number().int().min(0).max(1000000).optional(),
          filter: values.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('database_execute'),
      arguments: z.union([
        z
          .object({
            sql: z.string().min(1).max(65536),
            parameters: z.array(z.unknown()).max(100).optional(),
          })
          .strict(),
        z.object({ command: values }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      operation: z.literal('environment_get'),
      arguments: z.object({ name: variable }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('environment_create'),
      arguments: z.object({ name: variable, value: z.string().max(32768) }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('environment_update'),
      arguments: z.object({ name: variable, value: z.string().max(32768) }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('environment_rename'),
      arguments: z.object({ name: variable, newName: variable }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('environment_delete'),
      arguments: z.object({ name: variable }).strict(),
    })
    .strict(),
]);
export function parseResourceControlRequest(input: unknown) {
  const { threadId, turnId, ...control } = z
    .object({ threadId: z.string().min(1).max(200), turnId: z.string().min(1).max(200) })
    .passthrough()
    .parse(input);
  return { threadId, turnId, ...resourceControlSchema.parse(control) };
}
