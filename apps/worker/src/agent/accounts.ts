import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  agentSettingsSchema,
  type AgentPrivateSettings,
  type AgentSettings,
} from '@repellet/shared';
import type {
  ChatgptAuthTokensRefreshResponse,
  LoginAccountResponse,
} from '@repellet/agent-protocol';
import { AgentConnection } from './connection.js';
import { readAuthCache, legacyPiCredential } from './auth-cache.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { CredentialStore } from '@earendil-works/pi-ai';
const { AuthStorage } = (await import(
  new URL('./core/auth-storage.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href
)) as { AuthStorage: { create(path: string): CredentialStore } };
export const accountsRoot =
  process.env.AGENT_ACCOUNTS_HOME || path.join(os.homedir(), '.repellet-agent-accounts');
const servers = new Map<string, Promise<AgentConnection>>();
const refreshes = new Map<string, Promise<ChatgptAuthTokensRefreshResponse>>();
const locks = new Map<string, Promise<unknown>>();
const piLoginControllers = new Map<string, AbortController>();
const logins = new Map<
  string,
  {
    login: LoginAccountResponse | null;
    state: 'pending' | 'completed' | 'error' | 'cancelled';
    error: string | null;
  }
>();
export function userId(value: string) {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid user ID');
  return value;
}
export async function withAccount<T>(id: string, operation: () => Promise<T>): Promise<T> {
  userId(id);
  const next = (locks.get(id) || Promise.resolve()).catch(() => {}).then(operation);
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}
export const accountHome = (id: string) => path.join(accountsRoot, userId(id));
async function prepareHome(id: string) {
  const home = accountHome(id);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700);
  if (process.getuid?.() === 0) await fs.chown(home, 1001, 1001);
  return home;
}
type AccountService = { call(method: string, params?: any): Promise<any>; close(): Promise<void> };
async function accountServer(id: string): Promise<AccountService> {
  const binary = process.env.NODE_ENV === 'test' ? process.env.AGENT_ACCOUNT_BINARY : undefined;
  if (!binary) return localPiAccountService(id);
  if (!servers.has(id))
    servers.set(
      id,
      (async () => {
        const home = await prepareHome(id);
        const child = spawn(binary, [], {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, AGENT_ACCOUNT_HOME: home },
          ...(process.getuid?.() === 0 ? { uid: 1001, gid: 1001 } : {}),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const connection = new AgentConnection({
          input: child.stdin,
          output: child.stdout,
          errors: child.stderr,
          close: () => {
            child.kill('SIGTERM');
          },
        });
        child.on('error', () => {
          void connection.close();
        });
        connection.on('failure', () => {
          servers.delete(id);
        });
        connection.on('request', (request) =>
          connection.reject(request.id, 'Auth-only server does not support agent operations'),
        );
        connection.on('notification', (event) => {
          if (event.method !== 'account/login/completed') return;
          const current = logins.get(id);
          if (
            current?.login &&
            'loginId' in current.login &&
            current.login.loginId === event.params.loginId &&
            current.state === 'pending'
          ) {
            current.state = event.params.success ? 'completed' : 'error';
            current.error = event.params.success
              ? null
              : 'ChatGPT login failed or expired. Start sign-in again.';
          }
        });
        await connection.initialize();
        return connection;
      })().catch((e) => {
        servers.delete(id);
        throw e;
      }),
    );
  return servers.get(id)!;
}
const piLoginTasks = new Map<string, Promise<void>>();
async function cancelPiLogin(id: string) {
  piLoginControllers.get(id)?.abort();
  await piLoginTasks.get(id);
}
async function startPiDeviceLogin(id: string) {
  await cancelPiLogin(id);
  const home = await prepareHome(id);
  const store = AuthStorage.create(path.join(home, 'auth.json'));
  const controller = new AbortController();
  piLoginControllers.set(id, controller);
  const loginId = randomUUID();
  const state = {
    login: null as LoginAccountResponse | null,
    state: 'pending' as 'pending' | 'completed' | 'error' | 'cancelled',
    error: null as string | null,
  };
  logins.set(id, state);
  let resolveDevice!: (value: LoginAccountResponse) => void;
  let rejectDevice!: (error: Error) => void;
  const device = new Promise<LoginAccountResponse>((resolve, reject) => {
    resolveDevice = resolve;
    rejectDevice = reject;
  });
  const runtime = await ModelRuntime.create({
    credentials: {
      read: (p, options) => store.read(p, options),
      list: (options) => store.list(options),
      delete: (p, options) => store.delete(p, options),
      modify: (p, fn, options) =>
        store.modify(
          p,
          async (current) => {
            const value = await fn(current);
            if (controller.signal.aborted || piLoginControllers.get(id) !== controller)
              throw new Error('Login cancelled');
            return value;
          },
          options,
        ),
    },
    modelsPath: null,
    refreshOnCreate: false,
  });
  const task = runtime
    .login(
      'openai-codex',
      'oauth',
      {
        signal: controller.signal,
        prompt: async (prompt) => (prompt.type === 'select' ? 'device_code' : ''),
        notify: async (event) => {
          if (event.type === 'device_code' && !controller.signal.aborted) {
            const login: LoginAccountResponse = {
              type: 'chatgptDeviceCode',
              loginId,
              userCode: event.userCode,
              verificationUrl: event.verificationUri,
            };
            state.login = login;
            resolveDevice(login);
          }
        },
      },
      { agentName: 'Repellet' },
    )
    .then(() => {
      if (!controller.signal.aborted && piLoginControllers.get(id) === controller)
        state.state = 'completed';
    })
    .catch(() => {
      state.state = controller.signal.aborted ? 'cancelled' : 'error';
      state.error = controller.signal.aborted
        ? null
        : 'ChatGPT login failed or expired. Start sign-in again.';
      rejectDevice(new Error(state.error || 'Login cancelled'));
    })
    .finally(() => {
      if (piLoginControllers.get(id) === controller) piLoginControllers.delete(id);
      if (piLoginTasks.get(id) === task) piLoginTasks.delete(id);
    });
  piLoginTasks.set(id, task);
  return device;
}
async function localPiAccountService(id: string): Promise<AccountService> {
  const home = await prepareHome(id);
  const authFile = path.join(home, 'auth.json');
  let legacy = null;
  try {
    legacy = legacyPiCredential(await fs.readFile(authFile, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (legacy) {
    const temporary = path.join(home, '.auth-' + randomUUID());
    try {
      await fs.writeFile(temporary, JSON.stringify({ 'openai-codex': legacy }), {
        mode: 0o600,
        flag: 'wx',
      });
      await fs.rename(temporary, authFile);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  const store = AuthStorage.create(path.join(home, 'auth.json'));
  return {
    async call(method, params = {}) {
      if (method === 'account/read') {
        if (params.refreshToken && (await store.read('openai-codex'))) {
          const runtime = await ModelRuntime.create({
            credentials: store,
            modelsPath: null,
            refreshOnCreate: false,
          });
          await runtime.getAuth('openai-codex', { minOAuthValidityMs: 600000 });
        }
        return {
          account: (await store.read('openai-codex'))
            ? { type: 'chatgpt', authMode: 'oauth' }
            : null,
        };
      }
      if (method === 'account/login/start') return startPiDeviceLogin(id);
      if (method === 'account/login/cancel') {
        await cancelPiLogin(id);
        return { ok: true };
      }
      if (method === 'account/logout') {
        await cancelPiLogin(id);
        await store.delete('openai-codex');
        return { ok: true };
      }
      throw new Error('Pi account service does not support this operation');
    },
    async close() {
      await cancelPiLogin(id);
    },
  };
}
const defaults: AgentPrivateSettings = {
  mode: 'chatgpt',
  baseUrl: '',
  model: '',
  effort: null,
  apiKey: null,
};
export async function privateSettings(id: string): Promise<AgentPrivateSettings> {
  try {
    const data = JSON.parse(
      await fs.readFile(path.join(accountHome(id), 'repellet-settings.json'), 'utf8'),
    );
    const parsed = agentSettingsSchema.parse(data);
    return { ...defaults, ...parsed, apiKey: parsed.apiKey ?? null };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults };
    throw new Error('Agent settings are incompatible. Reconnect your provider.');
  }
}
export const publicSettings = ({ apiKey, ...settings }: AgentPrivateSettings): AgentSettings => ({
  ...settings,
  hasApiKey: !!apiKey,
});
export async function saveSettings(id: string, input: unknown) {
  const update = agentSettingsSchema.parse(input);
  const previous = await privateSettings(id);
  const next = {
    ...previous,
    ...update,
    effort: update.effort ?? null,
    apiKey: update.apiKey === undefined ? previous.apiKey : update.apiKey,
  };
  if (next.mode === 'custom' && (!next.baseUrl || !next.apiKey?.trim() || !next.model))
    throw Object.assign(
      new Error('Custom API requires a Responses API base URL, key, and model ID'),
      { statusCode: 400 },
    );
  const home = await prepareHome(id);
  const temporary = path.join(home, '.settings-' + randomUUID());
  try {
    await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, path.join(home, 'repellet-settings.json'));
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return publicSettings(next);
}
export async function readAccount(id: string) {
  try {
    const server = await accountServer(id);
    const result = await server.call('account/read', { refreshToken: false });
    return { ...result, login: logins.get(id) || null };
  } catch {
    throw new Error(
      'ChatGPT account service is unavailable. Retry or reconnect in Agent settings.',
    );
  }
}
export async function startLogin(id: string) {
  await refreshes.get(id)?.catch(() => {});
  const server = await accountServer(id);
  const old = logins.get(id);
  if (old?.state === 'pending' && old.login && 'loginId' in old.login)
    await server.call('account/login/cancel', { loginId: old.login.loginId });
  const login = (await server.call('account/login/start', {
    type: 'chatgptDeviceCode',
  })) as LoginAccountResponse;
  if (!piLoginControllers.has(id) && !logins.has(id))
    logins.set(id, { login, state: 'pending', error: null });
  else if (process.env.AGENT_ACCOUNT_BINARY)
    logins.set(id, { login, state: 'pending', error: null });
  return login;
}
export async function cancelLogin(id: string, loginId: string) {
  const current = logins.get(id);
  if (!current?.login || !('loginId' in current.login) || current.login.loginId !== loginId)
    throw Object.assign(new Error('Login is no longer pending for this account'), {
      statusCode: 409,
    });
  await (await accountServer(id)).call('account/login/cancel', { loginId });
  current.state = 'cancelled';
  return { ok: true };
}
export async function logout(id: string) {
  // Project processes close before logout. Finish their pending refresh before
  // clearing the central cache, so it cannot repopulate afterward.
  await refreshes.get(id)?.catch(() => {});
  await (await accountServer(id)).call('account/logout');
  logins.delete(id);
  return { ok: true };
}
export async function accessTokens(id: string): Promise<ChatgptAuthTokensRefreshResponse> {
  if (!refreshes.has(id))
    refreshes.set(
      id,
      (async () => {
        try {
          const server = await accountServer(id);
          await server.call('account/read', { refreshToken: true });
          return readAuthCache(await fs.readFile(path.join(accountHome(id), 'auth.json'), 'utf8'));
        } catch {
          throw Object.assign(new Error('Reconnect ChatGPT in Agent settings to continue.'), {
            statusCode: 401,
          });
        }
      })().finally(() => refreshes.delete(id)),
    );
  return refreshes.get(id)!;
}
export async function importExistingHistory(id: string, projectIds: string[]) {
  userId(id);
  return (await import('./migration.js')).importProjectHistory(projectIds);
}

export async function closeAccounts() {
  for (const controller of piLoginControllers.values()) controller.abort();
  await Promise.all([...piLoginTasks.values()]);
  piLoginControllers.clear();
  for (const server of servers.values()) await (await server).close();
  servers.clear();
}
