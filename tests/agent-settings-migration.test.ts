import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  globalEnabled: false,
  writes: [] as any[],
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  promises: {
    readFile: async (file: string) => {
      if (!state.files.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return state.files.get(file);
    },
    mkdir: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    chown: vi.fn(async () => {}),
    writeFile: async (file: string, data: string, options: any) => {
      state.files.set(file, data);
      state.writes.push(options);
    },
    rename: async (from: string, to: string) => {
      state.files.set(to, state.files.get(from)!);
      state.files.delete(from);
    },
    rm: async (file: string) => {
      state.files.delete(file);
    },
  },
}));
vi.mock('@earendil-works/pi-coding-agent', () => ({ ModelRuntime: { create: vi.fn() } }));
vi.mock('../apps/worker/src/agent/providers.js', () => ({
  globalSettings: async () => ({ enabled: state.globalEnabled }),
  validatePreferences: vi.fn(async () => {}),
  userSettings: async () => ({ version: 2 }),
}));
import {
  migrateSettings,
  defaultSettings,
  storedSettings,
  accountHome,
  saveSettings,
} from '../apps/worker/src/agent/accounts.js';
const user = '11111111-1111-1111-1111-111111111111';
const file = () => accountHome(user) + '/repellet-settings.json';
beforeEach(() => {
  state.files.clear();
  state.writes.length = 0;
  state.globalEnabled = false;
});
it('migrates legacy proxy defaults and credentials while retaining the built-in ChatGPT default behavior', () => {
  for (const mode of ['custom', 'chatgpt']) {
    const migrated = migrateSettings({
      mode,
      baseUrl: 'https://personal.invalid/v1',
      model: 'proxy-model',
      effort: 'ultra',
      apiKey: 'personal-key',
    });
    expect(migrated.defaultApi).toBe(mode === 'custom' ? 'cliproxyapi' : 'chatgpt');
    expect(migrated.defaults.cliproxyapi).toEqual({ model: 'proxy-model', effort: 'ultra' });
    expect(migrated.defaults.chatgpt).toEqual({ model: '', effort: null });
    expect(migrated.personalProxy.apiKey).toBe('personal-key');
  }
});
it('reads legacy settings without modifying their file and defaults missing accounts safely', async () => {
  const old = JSON.stringify({
    mode: 'custom',
    baseUrl: 'https://personal.invalid/v1',
    model: 'model',
    apiKey: 'private-key',
  });
  state.files.set(file(), old);
  expect((await storedSettings(user)).defaultApi).toBe('cliproxyapi');
  expect(state.files.get(file())).toBe(old);
  expect(state.writes).toEqual([]);
  state.files.clear();
  expect(await storedSettings(user)).toEqual(defaultSettings());
});
it('preserves personal credentials while saving managed defaults and rejects explicit and legacy connection mutations', async () => {
  const saved = defaultSettings();
  saved.personalProxy = { baseUrl: 'https://personal.invalid/v1', apiKey: 'retained-key' };
  state.files.set(file(), JSON.stringify(saved));
  state.globalEnabled = true;
  const { personalProxy: _, ...preferences } = saved;
  await saveSettings(user, { ...preferences, defaultApi: 'cliproxyapi' });
  expect((await storedSettings(user)).personalProxy.apiKey).toBe('retained-key');
  const before = state.files.get(file());
  await expect(saveSettings(user, saved)).rejects.toThrow('administrator');
  await expect(
    saveSettings(user, { mode: 'chatgpt', baseUrl: '', model: '', apiKey: null }),
  ).rejects.toThrow('administrator');
  expect(state.files.get(file())).toBe(before);
});
it('supports retaining, replacing, and removing personal keys with atomic private writes', async () => {
  const saved = defaultSettings();
  saved.personalProxy = { baseUrl: 'https://personal.invalid/v1', apiKey: 'retained-key' };
  state.files.set(file(), JSON.stringify(saved));
  const { personalProxy: _, ...preferences } = saved;
  await saveSettings(user, {
    ...preferences,
    personalProxy: { baseUrl: saved.personalProxy.baseUrl },
  });
  expect((await storedSettings(user)).personalProxy.apiKey).toBe('retained-key');
  for (const apiKey of ['replacement', null]) {
    await saveSettings(user, {
      ...preferences,
      personalProxy: { baseUrl: saved.personalProxy.baseUrl, apiKey },
    });
    expect((await storedSettings(user)).personalProxy.apiKey).toBe(apiKey);
  }
  expect(state.writes.every((options) => options.mode === 0o600 && options.flag === 'wx')).toBe(
    true,
  );
  expect([...state.files.keys()]).toEqual([file()]);
});
