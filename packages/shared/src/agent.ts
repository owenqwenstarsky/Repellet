import { z } from 'zod';
import { MAX_AGENT_IMAGES, MAX_AGENT_TEXT_FILES } from './attachments.js';
import type {
  ServerNotification,
  ThreadItem,
  ToolRequestUserInputParams,
} from '@repellet/agent-protocol';
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
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !url.search
      );
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) Responses API base URL without credentials, query, or fragment');
export const legacyAgentSettingsSchema = z
  .object({
    mode: z.enum(['chatgpt', 'custom']),
    baseUrl: providerUrlSchema.or(z.literal('')),
    model: z.string().trim().max(200),
    effort: reasoningEffortSchema.nullable().optional(),
    // Omitted retains the key; null removes it; a string replaces it.
    apiKey: z.string().min(1).max(32768).nullable().optional(),
  })
  .strict();
export type LegacyAgentSettings = {
  mode: 'chatgpt' | 'custom';
  baseUrl: string;
  model: string;
  effort: z.infer<typeof reasoningEffortSchema> | null;
  hasApiKey: boolean;
};
/** Legacy shape retained at the private process adapter boundary. */
export type AgentPrivateSettings = Omit<LegacyAgentSettings, 'hasApiKey'> & {
  apiKey: string | null;
  proxyModels?: string[];
  defaults?: AgentStoredSettings['defaults'];
};
export const agentApiSchema = z.enum(['chatgpt', 'cliproxyapi']);
export type AgentApi = z.infer<typeof agentApiSchema>;
const preferenceSchema = z
  .object({
    model: z.string().trim().max(200),
    effort: reasoningEffortSchema.nullable(),
  })
  .strict();
export const proxyConnectionSchema = z
  .object({
    baseUrl: providerUrlSchema.or(z.literal('')),
    apiKey: z.string().trim().min(1).max(32768).nullable().optional(),
  })
  .strict();
export const agentPreferencesSchema = z
  .object({
    version: z.literal(2),
    defaultApi: agentApiSchema,
    defaults: z.object({ chatgpt: preferenceSchema, cliproxyapi: preferenceSchema }).strict(),
    personalProxy: proxyConnectionSchema.optional(),
  })
  .strict();
export const agentSettingsSchema = z.union([agentPreferencesSchema, legacyAgentSettingsSchema]);
export type AgentStoredSettings = Omit<z.infer<typeof agentPreferencesSchema>, 'personalProxy'> & {
  personalProxy: { baseUrl: string; apiKey: string | null };
};
export type AgentSettings = Omit<AgentStoredSettings, 'personalProxy'> & {
  personalProxy?: { baseUrl: string; hasApiKey: boolean };
  proxySource: 'global' | 'personal' | 'none';
  availability: Record<AgentApi, { available: boolean; reason: string | null }>;
};
export const globalAgentApiSchema = proxyConnectionSchema
  .extend({
    enabled: z.boolean(),
    allowedModels: z.array(z.string().trim().min(1).max(200)).max(10000),
  })
  .strict();
export type GlobalAgentApiSettings = {
  enabled: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  allowedModels: string[];
  models: string[];
  fetchedAt: number | null;
};
export type AgentModelCatalog = {
  data: import('@repellet/agent-protocol').Model[];
  nextCursor: null;
  error: string | null;
};
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
// An explicit empty model selects the provider default; omission restores thread preferences.
const model = z.string().trim().max(200).optional();
const api = agentApiSchema.optional();
const effort = reasoningEffortSchema.nullable().optional();
const input = z
  .array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string().min(1).max(100000) }).strict(),
      z
        .object({
          type: z.literal('attachment'),
          attachmentId: z.string().uuid(),
          kind: z.enum(['image', 'text']),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(18)
  .superRefine((items, ctx) => {
    for (const [kind, limit] of [
      ['image', MAX_AGENT_IMAGES],
      ['text', MAX_AGENT_TEXT_FILES],
    ] as const)
      if (items.filter((item) => item.type === 'attachment' && item.kind === kind).length > limit)
        ctx.addIssue({ code: 'custom', message: `Attach at most ${limit} ${kind} files` });
    const ids = items.filter((item) => item.type === 'attachment').map((item) => item.attachmentId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate attachment' });
    if (items.filter((item) => item.type === 'text').length > 10)
      ctx.addIssue({ code: 'custom', message: 'Too many text inputs' });
  });
const thread = z.object({ threadId: id }).strict();
const methods = {
  'thread/start': z.object({ api, model, effort }).strict(),
  'thread/list': z
    .object({
      cursor: z.string().max(1000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      archived: z.boolean().optional(),
      search: z.string().trim().max(200).optional(),
    })
    .strict(),
  'thread/read': thread.extend({ includeTurns: z.boolean().optional() }),
  'thread/resume': thread.extend({ api, model, effort }),
  'thread/fork': thread.extend({ api, model, effort }),
  'thread/plan/toggle': thread,
  'thread/name/set': thread.extend({ name: z.string().trim().min(1).max(100) }),
  'thread/archive': thread,
  'thread/unarchive': thread,
  'thread/compact/start': thread.extend({ api, model, effort }),
  'turn/start': thread.extend({ api, input, model, effort }),
  'turn/steer': thread.extend({ input, expectedTurnId: id }),
  'turn/interrupt': thread.extend({ turnId: id }),
  'model/list': z
    .object({
      api,
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
/** Validate the answer against the pending question before resolving it. */
export function validQuestionAnswers(
  questions: ToolRequestUserInputParams['questions'],
  answers: Record<string, { answers: string[] }>,
): boolean {
  return (
    Object.keys(answers).every((id) => questions.some((question) => question.id === id)) &&
    questions.every((question) => {
      const values = answers[question.id]?.answers;
      if (!values?.[0]?.trim()) return false;
      const option = question.options?.find((option) => option.label === values[0]);
      if (question.isOther === false && question.options?.length && !option) return false;
      return !option?.textInput || !!values[1]?.trim();
    })
  );
}
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
  compacting?: boolean;
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
  | { type: 'compaction'; generation: string; sequence: number; active: boolean }
  | { type: 'process/error'; generation: string; sequence: number; message: string };

/** Redact content without altering protocol identifiers, discriminants, or model IDs. */
export function redactAgentPayload<T>(value: T, secrets: string[]): T {
  const structural = new Set([
    'role',
    'api',
    'stopReason',
    'toolName',
    'name',
    'cwd',
    'effort',
    'thinkingLevel',
    'source',
    'method',
    'type',
    'id',
    'threadId',
    'turnId',
    'itemId',
    'generation',
    'status',
    'provider',
    'model',
    'modelProvider',
    'reasoningEffort',
    'defaultReasoningEffort',
    'previousAccountId',
    'chatgptAccountId',
  ]);
  function visit(value: unknown, field = ''): unknown {
    if (typeof value === 'string') {
      if (structural.has(field)) return value;
      let text = value;
      for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
      return text;
    }
    if (Array.isArray(value)) return value.map((entry) => visit(entry, field));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, visit(entry, key)]),
      );
    return value;
  }
  return visit(value) as T;
}
