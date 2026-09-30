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
