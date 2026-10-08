import { z } from 'zod';

/** Increment only for incompatible wire changes. Additive fields remain version 1. */
export const WORKSPACE_PROTOCOL_VERSION = 1 as const;
export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const projectRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export const workspaceActorSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(80),
  role: projectRoleSchema,
});
export type WorkspaceActor = z.infer<typeof workspaceActorSchema>;
export const workspaceEventSchema = z.object({
  version: z.literal(WORKSPACE_PROTOCOL_VERSION),
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  projectId: z.string().uuid(),
  actor: workspaceActorSchema.optional(),
  type: z.enum([
    'presence',
    'document',
    'file',
    'structure',
    'process',
    'terminal',
    'preview',
    'agent',
    'project',
    'error',
  ]),
  payload: z.unknown(),
});
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
export type WorkspaceStreamMessage =
  | { type: 'event'; event: WorkspaceEvent }
  | { type: 'ready'; version: 1; cursor: number }
  | {
      type: 'resync-required';
      version: 1;
      cursor: number;
      reason: 'expired' | 'ahead' | 'initial';
    };
export const workspaceCursorSchema = z.coerce
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const relativePath = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !/^[A-Za-z]:/.test(value) &&
      !value.split('/').includes('..'),
    'Path must stay within the workspace',
  );
export const runProfileInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    command: z.string().max(4096),
    cwd: relativePath.default(''),
    environmentKeys: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(100)
      .default([]),
    previewTargetId: z.string().uuid().optional(),
    autoStart: z.boolean().default(false),
  })
  .strict();
export const runProfileSchema = runProfileInputSchema.extend({ id: z.string().uuid() });
export type RunProfile = z.infer<typeof runProfileSchema>;
export const workspaceProcessSchema = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid().optional(),
  kind: z.enum(['run', 'task', 'terminal']),
  status: z.enum(['starting', 'running', 'exited', 'failed', 'stopped']),
  pid: z.number().int().positive().optional(),
  exitCode: z.number().int().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  actorId: z.string().uuid().optional(),
});
export type WorkspaceProcess = z.infer<typeof workspaceProcessSchema>;
export const previewTargetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  targetPort: z.number().int().min(1024).max(65535),
  allocatedPort: z.number().int().min(1024).max(65535).nullable(),
  status: z.enum(['stopped', 'starting', 'available', 'timeout', 'failed']),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  lastProbe: z.string().datetime().nullable(),
  generation: z.number().int().nonnegative(),
});
export type PreviewTarget = z.infer<typeof previewTargetSchema>;
export const projectAgentPolicySchema = z
  .object({
    enabled: z.boolean(),
    provider: z.literal('custom'),
    model: z.string().max(200),
    reasoningEffort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .nullable(),
    credentialConfigured: z.boolean(),
    editorsCanExecute: z.boolean(),
    viewersCanObserve: z.boolean(),
    maxConcurrentTurns: z.literal(1),
  })
  .strict();
export type ProjectAgentPolicy = z.infer<typeof projectAgentPolicySchema>;
export type ProjectCapability = 'view' | 'edit' | 'run' | 'manage' | 'agent.execute';
/** Site administration never enters the project capability calculation. */
export function hasProjectCapability(
  role: z.infer<typeof projectRoleSchema>,
  capability: ProjectCapability,
  policy?: ProjectAgentPolicy,
) {
  if (capability === 'agent.execute')
    return (
      !!policy?.enabled &&
      policy.credentialConfigured &&
      (role === 'owner' || (role === 'editor' && policy.editorsCanExecute))
    );
  return (
    capability === 'view' ||
    role === 'owner' ||
    (role === 'editor' && (capability === 'edit' || capability === 'run'))
  );
}
export type DocumentIdentity = {
  id: string;
  path: string;
  revision: number;
  dirty: boolean;
  conflict: boolean;
};
export type OperationalProject = {
  id: string;
  name: string;
  ownerName: string;
  state: string;
  storageBytes: number;
  storageExceeded: boolean;
  canOpen: boolean;
};
