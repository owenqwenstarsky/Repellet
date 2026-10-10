// @vitest-environment jsdom
import { it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, uploadAgentAttachment } from '../apps/web/src/api';
afterEach(() => vi.unstubAllGlobals());
it('uploads attachment bytes with progress and aborts when removed', async () => {
  const requests: any[] = [];
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      upload: any = {};
      status = 200;
      responseText = JSON.stringify({ id: 'attachment' });
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn();
      onload: () => void = () => {};
      onabort: () => void = () => {};
      abort = vi.fn(() => this.onabort());
      constructor() {
        requests.push(this);
      }
    },
  );
  const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const progress = vi.fn();
  const pending = uploadAgentAttachment(
    'project',
    file,
    file.type,
    'Pasted text',
    progress,
    new AbortController().signal,
  );
  const request = requests[0];
  expect(request.open).toHaveBeenCalledWith(
    'POST',
    '/api/projects/project/agent/attachments?name=notes.txt&mimeType=text%2Fplain&label=Pasted+text',
  );
  expect(request.setRequestHeader).toHaveBeenCalledWith('content-type', 'application/octet-stream');
  expect(request.send).toHaveBeenCalledWith(file);
  request.upload.onprogress({ lengthComputable: true, loaded: 2, total: 4 });
  expect(progress).toHaveBeenCalledWith(50);
  request.onload();
  await expect(pending).resolves.toEqual({ id: 'attachment' });
  const controller = new AbortController();
  const cancelled = uploadAgentAttachment(
    'project',
    file,
    file.type,
    undefined,
    progress,
    controller.signal,
  );
  const rejected = expect(cancelled).rejects.toThrow('cancelled');
  controller.abort();
  await rejected;
  expect(requests[1].abort).toHaveBeenCalledTimes(1);
});
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
