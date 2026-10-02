import { z } from 'zod';
import type {
  ServerNotification,
  ThreadItem,
  ToolRequestUserInputParams,
} from '@repellet/codex-protocol';
export const reasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
export const providerUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    );
  }, 'Use an HTTP(S) Responses API base URL without credentials, query, or fragment');
export const agentSettingsSchema = z
  .object({
    mode: z.enum(['chatgpt', 'custom']),
    baseUrl: providerUrlSchema.or(z.literal('')),
    model: z.string().trim().max(200),
    effort: reasoningEffortSchema.nullable().optional(),
    // Omitted retains the key; null removes it; a string replaces it.
    apiKey: z.string().min(1).max(32768).nullable().optional(),
  })
  .strict();
export type AgentSettings = {
  mode: 'chatgpt' | 'custom';
  baseUrl: string;
  model: string;
  effort: z.infer<typeof reasoningEffortSchema> | null;
  hasApiKey: boolean;
};
export type AgentPrivateSettings = Omit<AgentSettings, 'hasApiKey'> & { apiKey: string | null };
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const model = z.string().trim().min(1).max(200).optional();
const input = z
  .array(z.object({ type: z.literal('text'), text: z.string().min(1).max(100000) }).strict())
  .min(1)
  .max(10);
const thread = z.object({ threadId: id }).strict();
const methods = {
  'thread/start': z.object({ model }).strict(),
  'thread/list': z
    .object({
      cursor: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      archived: z.boolean().optional(),
    })
    .strict(),
  'thread/read': thread.extend({ includeTurns: z.boolean().optional() }),
  'thread/resume': thread.extend({ model }),
  'thread/fork': thread.extend({ model }),
  'thread/name/set': thread.extend({ name: z.string().trim().min(1).max(100) }),
  'thread/archive': thread,
  'thread/unarchive': thread,
  'thread/compact/start': thread,
  'turn/start': thread.extend({ input, model, effort: reasoningEffortSchema.optional() }),
  'turn/steer': thread.extend({ input, expectedTurnId: id }),
  'turn/interrupt': thread.extend({ turnId: id }),
  'model/list': z
    .object({
      cursor: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  'question/respond': z
    .object({
      requestId: z.union([z.string().max(200), z.number().int()]),
      answers: z.record(
        z.object({ answers: z.array(z.string().max(10000)).min(1).max(20) }).strict(),
      ),
    })
    .strict(),
};
export type AgentMethod = keyof typeof methods;
export const agentRpcSchema = z
  .object({
    generation: z.string().uuid(),
    method: z.enum(Object.keys(methods) as [AgentMethod, ...AgentMethod[]]),
    params: z.unknown(),
  })
  .strict()
  .transform((value, ctx) => {
    const parsed = methods[value.method].safeParse(value.params ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ ...issue, path: ['params', ...issue.path] });
      return z.NEVER;
    }
    return { ...value, params: parsed.data as Record<string, any> };
  });
export type AgentRpc = z.infer<typeof agentRpcSchema>;
export type AgentQuestion = {
  displayThreadId?: string;
  id: string | number;
  params: ToolRequestUserInputParams;
};
export type AgentSnapshot = {
  generation: string;
  sequence: number;
  connected: boolean;
  active: { threadId: string; turnId: string } | null;
  waiting: boolean;
  pending: AgentQuestion[];
  items: { threadId: string; turnId: string; item: ThreadItem }[];
  error: string | null;
};
export type AgentEvent =
  | { type: 'snapshot'; snapshot: AgentSnapshot }
  | { type: 'event'; generation: string; sequence: number; event: ServerNotification }
  | { type: 'question'; generation: string; sequence: number; question: AgentQuestion }
  | { type: 'question/resolved'; generation: string; sequence: number; requestId: string | number }
  | { type: 'process/error'; generation: string; sequence: number; message: string };
