import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import {
  globalAgentApiSchema,
  proxyConnectionSchema,
  type AgentApi,
  type AgentSettings,
  type AgentStoredSettings,
  type AgentPrivateSettings,
  type AgentModelCatalog,
  type GlobalAgentApiSettings,
} from '@repellet/shared';
import type { Model } from '@repellet/agent-protocol';
import { accountsRoot, storedSettings, readAccount } from './accounts.js';

const TTL = 5 * 60 * 1000;
const connectionFingerprint = (connection: { baseUrl: string; apiKey: string | null }) =>
  createHash('sha256')
    .update(JSON.stringify([connection.baseUrl, connection.apiKey]))
    .digest('hex');
// Draft catalogs contain no credentials and do not alter active policy until saved.
const globalDrafts = new Map<string, Snapshot>();
const fail = (message: string, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });
type Snapshot = { models: string[]; fetchedAt: number };
type GlobalConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string | null;
  allowedModels: string[];
  catalog: Snapshot | null;
  revision: string;
};
const snapshotSchema = z.object({
  models: z.array(z.string().trim().min(1).max(200)).max(10000),
  fetchedAt: z.number().finite(),
});
const storedGlobalSchema = globalAgentApiSchema.extend({
  catalog: snapshotSchema.nullable(),
  revision: z.string(),
});
const emptyGlobal = (): GlobalConfig => ({
  enabled: false,
  baseUrl: '',
  apiKey: null,
  allowedModels: [],
  catalog: null,
  revision: '',
});
let policyQueue: Promise<unknown> = Promise.resolve();
/** Always take this lock before an account lock, including model-turn admission. */
export async function withProviderPolicy<T>(operation: () => Promise<T>): Promise<T> {
  const task = policyQueue.catch(() => {}).then(operation);
  policyQueue = task;
  return task;
}
async function readJson(file: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw fail(
      'Private agent configuration is unavailable. Ask the administrator to check it.',
      500,
    );
  }
}
async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp-' + randomUUID();
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
const globalFile = () => path.join(accountsRoot, 'global-cliproxyapi.json');
export async function globalSettings(): Promise<GlobalConfig> {
  const data = await readJson(globalFile());
  if (data === undefined) return emptyGlobal();
  const parsed = storedGlobalSchema.safeParse(data);
  if (!parsed.success)
    throw fail(
      'Global CLIProxyAPI configuration is unavailable. Ask the administrator to check it.',
      500,
    );
  return { ...parsed.data, apiKey: parsed.data.apiKey ?? null };
}
export async function publicGlobalSettings(): Promise<GlobalAgentApiSettings> {
  const value = await globalSettings();
  return {
    enabled: value.enabled,
    baseUrl: value.baseUrl,
    hasApiKey: !!value.apiKey,
    allowedModels: value.allowedModels,
    models: value.catalog?.models || [],
    fetchedAt: value.catalog?.fetchedAt ?? null,
  };
}
export async function discoverModels(connection: {
  baseUrl: string;
  apiKey: string | null;
}): Promise<Snapshot> {
  proxyConnectionSchema.parse({ baseUrl: connection.baseUrl, apiKey: connection.apiKey });
  if (!connection.baseUrl || !connection.apiKey)
    throw fail('A Responses API base URL and key are required');
  try {
    const response = await fetch(connection.baseUrl.replace(/\/+$/, '') + '/models', {
      headers: { authorization: `Bearer ${connection.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw fail(`Model discovery failed (HTTP ${response.status})`);
    // Do not buffer an unbounded upstream response or expose upstream error bodies.
    const reader = response.body?.getReader();
    if (!reader) throw fail('Model discovery returned an empty response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) throw fail('Model catalog is too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(body.data) || body.data.length > 10000) throw fail('Invalid model catalog');
    const ids = body.data.map((model: unknown) => {
      const id = (model as { id?: unknown })?.id;
      if (typeof id !== 'string' || !id.trim() || id.trim().length > 200)
        throw fail('Invalid model ID in catalog');
      return id.trim();
    });
    return { models: [...new Set<string>(ids)].sort(), fetchedAt: Date.now() };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw fail('Could not load models. Check the connection and retry.');
  }
}
export async function previewGlobalModels(input: unknown) {
  const draft = proxyConnectionSchema.parse(input);
  const previous = await globalSettings();
  const connection = {
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey === undefined ? previous.apiKey : draft.apiKey,
  };
  const catalog = await discoverModels(connection);
  globalDrafts.set(connectionFingerprint(connection), catalog);
  if (globalDrafts.size > 32) globalDrafts.delete(globalDrafts.keys().next().value!);
  return { models: catalog.models, fetchedAt: catalog.fetchedAt };
}
export async function previewPersonalModels(id: string, input: unknown) {
  if ((await globalSettings()).enabled)
    throw fail('CLIProxyAPI is managed by your administrator', 403);
  const draft = proxyConnectionSchema.parse(input);
  const previous = (await storedSettings(id)).personalProxy;
  const connection = {
    baseUrl: draft.baseUrl,
    apiKey: draft.apiKey === undefined ? previous.apiKey : draft.apiKey,
  };
  const catalog = await discoverModels(connection);
  const fingerprint = connectionFingerprint(connection);
  await writeJson(path.join(accountsRoot, id, 'repellet-models.json'), { fingerprint, catalog });
  return {
    ...(await modelCatalog(id, 'cliproxyapi', false, {
      ...(await storedSettings(id)),
      personalProxy: connection,
    })),
    models: catalog.models,
    fetchedAt: catalog.fetchedAt,
  };
}
export async function saveGlobalSettings(input: unknown) {
  const update = globalAgentApiSchema.parse(input);
  const previous = await globalSettings();
  const key = update.apiKey === undefined ? previous.apiKey : update.apiKey;
  const connectionChanged = update.baseUrl !== previous.baseUrl || key !== previous.apiKey;
  if (update.enabled && (!update.baseUrl || !key))
    throw fail('Disable CLIProxyAPI before removing its connection or key');
  const fingerprint = connectionFingerprint({ baseUrl: update.baseUrl, apiKey: key });
  const draft = globalDrafts.get(fingerprint);
  const freshDraft = draft && Date.now() - draft.fetchedAt < TTL ? draft : null;
  let catalog = freshDraft || (connectionChanged ? null : previous.catalog);
  if (update.enabled && !freshDraft && (!previous.enabled || connectionChanged || !catalog))
    catalog = await discoverModels({ baseUrl: update.baseUrl, apiKey: key });
  const allowedModels = [...new Set(update.allowedModels)].sort();
  if (
    update.enabled &&
    allowedModels.some(
      (id) => !catalog?.models.includes(id) && !previous.allowedModels.includes(id),
    )
  )
    catalog = await discoverModels({ baseUrl: update.baseUrl, apiKey: key });
  const unknown = allowedModels.filter(
    (id) => !catalog?.models.includes(id) && !previous.allowedModels.includes(id),
  );
  if (unknown.length) throw fail('Load models before selecting newly allowed model IDs');
  const next: GlobalConfig = {
    ...update,
    apiKey: key,
    allowedModels,
    catalog,
    revision: randomUUID(),
  };
  await writeJson(globalFile(), next);
  globalDrafts.delete(fingerprint);
  return publicGlobalSettings();
}
export function defaultModel(models: Model[], configured = ''): Model | undefined {
  if (configured) return models.find((model) => model.model === configured);
  const sols = models.filter((model) => /^gpt-\d+(?:\.\d+)*-sol$/i.test(model.model));
  sols.sort((a, b) => {
    const av = a.model.slice(4, -4).split('.').map(Number),
      bv = b.model.slice(4, -4).split('.').map(Number);
    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
      const delta = (bv[i] || 0) - (av[i] || 0);
      if (delta) return delta;
    }
    return 0;
  });
  return sols[0] || models[0];
}
let catalogRuntime: Promise<ModelRuntime> | undefined;
async function runtime() {
  return (catalogRuntime ||= ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => undefined,
      delete: async () => {},
    },
  }));
}
export async function chatgptCatalog(): Promise<Model[]> {
  const models = (await runtime()).getModels('openai-codex');
  return models.map((model) => ({
    id: 'chatgpt/' + model.id,
    model: model.id,
    displayName: model.name,
    isDefault: false,
    defaultReasoningEffort: model.reasoning ? 'medium' : null,
    supportedReasoningEfforts: getSupportedThinkingLevels(model).map((level) => ({
      reasoningEffort: level === 'off' ? 'none' : level,
      description: level,
    })),
  }));
}
async function proxyCatalog(id: string, preferences: AgentStoredSettings, refresh: boolean) {
  const global = await globalSettings();
  const connection = global.enabled ? global : preferences.personalProxy;
  if (!connection.baseUrl || !connection.apiKey)
    return { models: [] as string[], error: null as string | null };
  const fingerprint = connectionFingerprint(connection);
  const file = path.join(accountsRoot, id, 'repellet-models.json');
  const personal = global.enabled ? null : await readJson(file);
  const personalSnapshot =
    personal?.fingerprint === fingerprint ? snapshotSchema.safeParse(personal.catalog) : null;
  let cached: Snapshot | null = global.enabled
    ? global.catalog
    : personalSnapshot?.success
      ? personalSnapshot.data
      : null;
  let error: string | null = null;
  if (refresh || !cached || Date.now() - cached.fetchedAt >= TTL) {
    try {
      const next = await discoverModels(connection);
      if (global.enabled) {
        if (JSON.stringify(next.models) !== JSON.stringify(cached?.models))
          global.revision = randomUUID();
        global.catalog = next;
        await writeJson(globalFile(), global);
      } else await writeJson(file, { fingerprint, catalog: next });
      cached = next;
    } catch (e) {
      error = (e as Error).message;
    }
  }
  const models = cached?.models || [];
  return {
    models: global.enabled
      ? models.filter((model) => global.allowedModels.includes(model))
      : models,
    error,
  };
}
export async function modelCatalog(
  id: string,
  api: AgentApi,
  refresh = false,
  preferences?: AgentStoredSettings,
): Promise<AgentModelCatalog> {
  const settings = preferences || (await storedSettings(id));
  let data: Model[],
    error: string | null = null;
  if (api === 'chatgpt') data = await chatgptCatalog();
  else {
    const catalog = await proxyCatalog(id, settings, refresh);
    error = catalog.error;
    const known = await chatgptCatalog();
    data = catalog.models.map((model) => {
      const metadata = known.find((entry) => entry.model === model);
      return {
        id: 'cliproxyapi/' + model,
        model,
        displayName: model,
        isDefault: false,
        defaultReasoningEffort: metadata?.defaultReasoningEffort ?? 'medium',
        supportedReasoningEfforts:
          metadata?.supportedReasoningEfforts ||
          ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(
            (reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }),
          ),
      };
    });
  }
  const selected = defaultModel(data, settings.defaults[api].model);
  return {
    data: data.map((model) => ({ ...model, isDefault: model.model === selected?.model })),
    nextCursor: null,
    error,
  };
}
export async function userSettings(id: string): Promise<AgentSettings> {
  const preferences = await storedSettings(id),
    global = await globalSettings();
  const connected = await readAccount(id)
    .then((value) => !!value.account)
    .catch(() => false);
  const connection = global.enabled ? global : preferences.personalProxy;
  const ready = !!(connection.baseUrl && connection.apiKey);
  const usable =
    !global.enabled || global.allowedModels.some((id) => global.catalog?.models.includes(id));
  return {
    version: 2,
    defaultApi: preferences.defaultApi,
    defaults: preferences.defaults,
    ...(global.enabled
      ? {}
      : { personalProxy: { baseUrl: connection.baseUrl, hasApiKey: !!connection.apiKey } }),
    proxySource: global.enabled ? 'global' : ready ? 'personal' : 'none',
    availability: {
      chatgpt: {
        available: connected,
        reason: connected ? null : 'Sign in with ChatGPT in Agent settings.',
      },
      cliproxyapi: {
        available: ready && usable,
        reason: !ready
          ? 'Configure your custom API in Agent settings.'
          : !usable
            ? global.allowedModels.length
              ? 'The allowed proxy models are currently unavailable.'
              : 'Your administrator has not allowed any models.'
            : null,
      },
    },
  };
}
export async function validatePreferences(id: string, preferences: AgentStoredSettings) {
  const api = preferences.defaultApi;
  const global = await globalSettings();
  const previous = await storedSettings(id);
  if (
    !global.enabled &&
    JSON.stringify(previous.personalProxy) !== JSON.stringify(preferences.personalProxy) &&
    preferences.personalProxy.baseUrl &&
    preferences.personalProxy.apiKey
  ) {
    const catalog = await proxyCatalog(id, preferences, false);
    if (catalog.error) throw fail(catalog.error);
  }
  if (api === 'cliproxyapi') {
    const connection = global.enabled ? global : preferences.personalProxy;
    if (!connection.baseUrl || !connection.apiKey)
      throw fail('Configure a Responses API base URL and key first');
  }
  const { model, effort } = preferences.defaults[api];
  if (model || effort) {
    const catalog = await modelCatalog(id, api, false, preferences);
    const selected = defaultModel(catalog.data, model);
    if (!selected) throw fail('The default model is unavailable. Select another model.');
    if (
      effort &&
      !selected.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
    )
      throw fail('The default reasoning effort is unavailable for this model.');
  }
}
export async function runtimeSettings(id: string): Promise<AgentPrivateSettings> {
  const preferences = await storedSettings(id),
    global = await globalSettings();
  const connection = global.enabled ? global : preferences.personalProxy;
  const catalog = await proxyCatalog(id, preferences, false);
  return {
    mode: preferences.defaultApi === 'chatgpt' ? 'chatgpt' : 'custom',
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    ...preferences.defaults[preferences.defaultApi],
    defaults: preferences.defaults,
    proxyModels: catalog.models,
  };
}
