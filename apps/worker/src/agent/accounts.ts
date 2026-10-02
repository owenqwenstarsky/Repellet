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
} from '@repellet/codex-protocol';
import { CodexConnection } from './connection.js';
import { readAuthCache } from './auth-cache.js';
export const accountsRoot =
  process.env.AGENT_ACCOUNTS_HOME || path.join(os.homedir(), '.repellet-agent-accounts');
const servers = new Map<string, Promise<CodexConnection>>();
const refreshes = new Map<string, Promise<ChatgptAuthTokensRefreshResponse>>();
const locks = new Map<string, Promise<unknown>>();
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
async function accountServer(id: string) {
  if (!servers.has(id))
    servers.set(
      id,
      (async () => {
        const home = await prepareHome(id);
        const child = spawn(
          process.env.CODEX_BINARY || 'codex',
          ['app-server', '-c', 'cli_auth_credentials_store="file"'],
          {
            cwd: home,
            env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
            ...(process.getuid?.() === 0 ? { uid: 1001, gid: 1001 } : {}),
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        const connection = new CodexConnection({
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
          if (event.method === 'account/login/completed') {
            const current = logins.get(id);
            if (
              current &&
              current.login &&
              'loginId' in current.login &&
              current.login.loginId === event.params.loginId &&
              current.state === 'pending'
            ) {
              current.state = event.params.success ? 'completed' : 'error';
              current.error = event.params.success
                ? null
                : 'ChatGPT login failed or expired. Start sign-in again.';
            }
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
export async function closeAccounts() {
  for (const server of servers.values()) await (await server).close();
  servers.clear();
}
