import { vi, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const fake = vi.hoisted(() => ({ finish: null as null | (() => Promise<void>), failEarly: false }));
vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: async ({ credentials }: any) => ({
      login: async (_provider: string, _type: string, interaction: any) => {
        if (fake.failEarly) throw new Error('secret provider failure');
        await interaction.notify({
          type: 'device_code',
          userCode: 'PI-CODE',
          verificationUri: 'https://example.com/device',
        });
        return new Promise((resolve, reject) => {
          const fail = () => reject(new Error('Cancelled'));
          interaction.signal.addEventListener('abort', fail, { once: true });
          fake.finish = async () => {
            try {
              const value = await credentials.modify('openai-codex', async () => ({
                type: 'oauth',
                access: 'access-secret',
                refresh: 'refresh-secret',
                expires: Date.now() + 3600000,
                accountId: 'account',
              }));
              resolve(value);
            } catch (e) {
              reject(e);
            }
          };
        });
      },
      getAuth: async () =>
        credentials.modify('openai-codex', async (current: any) => ({
          ...current,
          expires: Date.now() + 3600000,
        })),
    }),
  },
}));
let root = '',
  accounts: typeof import('../apps/worker/src/agent/accounts.js');
const id = randomUUID();
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'repellet-pi-auth-'));
  process.env.AGENT_ACCOUNTS_HOME = root;
  delete process.env.AGENT_ACCOUNT_BINARY;
  accounts = await import('../apps/worker/src/agent/accounts.js');
});
afterAll(async () => {
  await accounts.closeAccounts();
  await rm(root, { recursive: true, force: true });
});
it('persists Pi credentials centrally and exposes only safe account/login metadata', async () => {
  const login = await accounts.startLogin(id);
  expect(login).toMatchObject({ type: 'chatgptDeviceCode', userCode: 'PI-CODE' });
  await fake.finish!();
  await vi.waitFor(async () =>
    expect((await accounts.readAccount(id)).login?.state).toBe('completed'),
  );
  expect(await readFile(path.join(root, id, 'auth.json'), 'utf8')).toContain('refresh-secret');
  expect(JSON.stringify(await accounts.readAccount(id))).not.toContain('secret');
});
it('cancels login before logout and rejects a late credential write', async () => {
  const login = await accounts.startLogin(id),
    late = fake.finish!;
  await accounts.cancelLogin(id, login.loginId);
  await accounts.logout(id);
  await late();
  expect((await accounts.readAccount(id)).account).toBeNull();
});
it('fails early login without leaving device-code UI polling forever or exposing provider errors', async () => {
  fake.failEarly = true;
  await expect(accounts.startLogin(id)).rejects.toThrow('ChatGPT login failed');
  expect((await accounts.readAccount(id)).login).toMatchObject({ state: 'error' });
  expect(JSON.stringify(await accounts.readAccount(id))).not.toContain('secret provider');
});

it('converts legacy central credentials without requiring an unexpired access token', async () => {
  const { legacyPiCredential } = await import('../apps/worker/src/agent/auth-cache.js');
  const access =
    'header.' +
    Buffer.from(
      JSON.stringify({
        exp: 1,
        'https://api.openai.com/auth': { chatgpt_account_id: 'old-account' },
      }),
    ).toString('base64url') +
    '.signature';
  expect(
    legacyPiCredential(
      JSON.stringify({
        tokens: { access_token: access, refresh_token: 'old-refresh', account_id: 'old-account' },
      }),
    ),
  ).toMatchObject({
    type: 'oauth',
    refresh: 'old-refresh',
    accountId: 'old-account',
    expires: 1000,
  });
});
