import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../docker/pi-extensions/upstream/websearch/extension.ts', () => ({
  default: (pi: any) => pi.registerTool({ name: 'web_search' }),
}));
vi.mock('../docker/pi-extensions/upstream/websearch/core.ts', () => ({
  SearchInput: {},
  localTime: vi.fn(),
  search: vi.fn(async () => ({
    text: 'Found it',
    details: { sources: [{ url: 'https://source.invalid', title: 'Source' }] },
  })),
}));
vi.mock('../docker/pi-extensions/upstream/websearch/config.ts', () => ({
  resolveSearchConfig: vi.fn(async (ctx: any) => ({
    backend: 'chatgpt',
    model: ctx.model.id,
    apiKey: 'chatgpt-private',
  })),
}));
import websearch from '../docker/pi-extensions/websearch.ts';
import { search } from '../docker/pi-extensions/upstream/websearch/core.ts';
import { resolveSearchConfig } from '../docker/pi-extensions/upstream/websearch/config.ts';
beforeEach(() => {
  vi.clearAllMocks();
});
it('routes search through the currently selected API/model and its in-memory credentials', async () => {
  const tools = new Map<string, any>();
  websearch({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  const tool = tools.get('web_search');
  const auth = vi.fn(async () => ({
    ok: true,
    apiKey: 'global-private',
    baseUrl: 'https://global.invalid/v1',
  }));
  const ctx = {
    model: { provider: 'repellet', id: 'proxy-model' },
    modelRegistry: { getApiKeyAndHeaders: auth },
  };
  const signal = new AbortController().signal;
  await tool.execute('id', { query: 'Current docs' }, signal, null, ctx);
  expect(search).toHaveBeenLastCalledWith(
    { query: 'Current docs' },
    {
      backend: 'cliproxyapi',
      baseUrl: 'https://global.invalid/v1',
      apiKey: 'global-private',
      model: 'proxy-model',
    },
    signal,
  );
  expect(auth).toHaveBeenCalledWith(ctx.model);
  expect(resolveSearchConfig).not.toHaveBeenCalled();
  ctx.model = { provider: 'openai-codex', id: 'chatgpt-model' };
  const result = await tool.execute('id', { query: 'Other docs' }, signal, null, ctx);
  expect(search).toHaveBeenLastCalledWith(
    { query: 'Other docs' },
    {
      backend: 'chatgpt',
      model: 'chatgpt-model',
      apiKey: 'chatgpt-private',
    },
    signal,
  );
  expect(result.content[0].text).toContain('https://source.invalid');
  expect(result.content[0].text).not.toMatch(/global-private|chatgpt-private/);
});
