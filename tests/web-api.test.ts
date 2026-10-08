// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from '../apps/web/src/api';
afterEach(() => vi.unstubAllGlobals());
it('exposes completed replacement files through ApiError', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 507,
      statusText: 'Storage exceeded',
      json: async () => ({ error: 'Stopped after updating 1 file', completedFiles: ['done.ts'] }),
    }),
  );
  const error = await api('/projects/project/replace').catch((e) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.completedFiles).toEqual(['done.ts']);
  expect(error.status).toBe(507);
});

it('creates an idempotency key when randomUUID is unavailable on an HTTP dev URL', async () => {
  vi.stubGlobal('crypto', {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.fill(1);
      return bytes;
    },
  });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal('fetch', fetch);

  await api('/projects/00000000-0000-0000-0000-000000000000/open', { method: 'POST' });

  const headers = fetch.mock.calls[0][1].headers as Record<string, string>;
  expect(headers['idempotency-key']).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

it('does not log out for provider authentication failures', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers(),
      json: async () => ({ error: 'Reconnect ChatGPT in Agent settings to continue.' }),
    }),
  );

  await expect(api('/projects/00000000-0000-0000-0000-000000000000/agent/status')).rejects.toThrow(
    'Reconnect ChatGPT',
  );
  expect(dispatch).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'repellet:unauthorized' }),
  );
});
