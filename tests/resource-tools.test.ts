import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import resources, {
  RESOURCE_READ_TOOLS,
  RESOURCE_WRITE_TOOLS,
} from '../docker/pi-extensions/resources.ts';
import { toolLabel } from '../apps/web/src/toolActivity.js';
vi.mock('../apps/worker/src/config.js', () => ({
  config: { appUrl: 'http://internal-api', token: 'private-worker-token' },
}));
import { forwardResourceControl } from '../apps/worker/src/agent/resource-control.js';

function fixture(enabled = false) {
  const tools = new Map<string, any>(),
    handlers = new Map<string, any>();
  const emit = vi.fn((_event, request) => request.resolve({ data: { names: ['DATABASE_URL'] } }));
  resources({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: any) => handlers.set(name, handler),
    events: { emit },
  } as any);
  const ctx = {
    sessionManager: {
      getBranch: () => [{ type: 'custom', customType: 'plan-mode-state', data: { enabled } }],
    },
  };
  return {
    tools,
    handlers,
    emit,
    ctx,
    execute: (name: string, args = {}) =>
      tools.get(name).execute('id', args, new AbortController().signal, undefined, ctx),
  };
}
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const context = (planMode = false) => ({
  projectId: 'current-project',
  userId: 'current-owner',
  active: () => ({ threadId: 'thread', turnId: 'turn' }),
  planMode: () => planMode,
});
const input = (operation: string, args = {}) => ({
  threadId: 'thread',
  turnId: 'turn',
  operation,
  arguments: args,
});
it('registers readable tools without connection/project arguments', () => {
  const f = fixture();
  expect([...f.tools.keys()].sort()).toEqual(
    [...RESOURCE_READ_TOOLS, ...RESOURCE_WRITE_TOOLS].sort(),
  );
  for (const [name, tool] of f.tools) {
    expect(toolLabel(name)).not.toBe(name);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/projectId|connectionString/);
  }
  expect(f.tools.has('database_create')).toBe(false);
});
it('blocks every resource mutation in restored plan mode and leaves reads available', async () => {
  const f = fixture(true);
  for (const name of RESOURCE_WRITE_TOOLS)
    expect(await f.execute(name)).toMatchObject({ isError: true });
  expect(f.emit).not.toHaveBeenCalled();
  for (const name of RESOURCE_READ_TOOLS) await f.execute(name);
  expect(f.emit).toHaveBeenCalledTimes(5);
});
it('limits all model-visible result data and refreshes the environment before bash', async () => {
  const f = fixture();
  f.emit.mockImplementation((_name, request) =>
    request.resolve({ data: { body: '😀'.repeat(20000) } }),
  );
  const result = await f.execute('database_read');
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(65536);
  expect(result.content[0].text).not.toContain('�');
  expect(result.details).toEqual({ truncated: true });
  f.emit.mockClear();
  await f.handlers.get('tool_call')({ toolName: 'bash' });
  expect(f.emit).toHaveBeenCalledWith(
    'repellet:resource-control',
    expect.objectContaining({ operation: 'environment_sync', arguments: {} }),
  );
});
it('binds resources to the active owner/project and never retries writes', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: null })));
  expect(
    await forwardResourceControl(context(), input('database_status'), new AbortController().signal),
  ).toEqual({ data: null });
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
    projectId: 'current-project',
    userId: 'current-owner',
    control: { operation: 'database_status', arguments: {} },
  });
  fetchMock.mockRejectedValue(new Error('private-key'));
  const result = await forwardResourceControl(
    context(),
    input('database_execute', { sql: 'DELETE FROM users' }),
    new AbortController().signal,
  );
  expect(result).toMatchObject({ error: { uncertain: true } });
  expect(JSON.stringify(result)).not.toContain('private-key');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('rejects stale turns, injected identity and all plan-mode writes at the worker', async () => {
  for (const request of [
    { ...input('database_status'), projectId: 'other' },
    { ...input('database_status'), turnId: 'old' },
    input('database_read', { name: 'users', command: {} }),
  ])
    expect(
      await forwardResourceControl(context(), request, new AbortController().signal),
    ).toHaveProperty('error');
  const args: Record<string, any> = {
    database_execute: { sql: 'SELECT 1' },
    environment_create: { name: 'A', value: 'x' },
    environment_update: { name: 'A', value: 'x' },
    environment_rename: { name: 'A', newName: 'B' },
    environment_delete: { name: 'A' },
  };
  for (const name of RESOURCE_WRITE_TOOLS)
    expect(
      await forwardResourceControl(
        context(true),
        input(name, args[name]),
        new AbortController().signal,
      ),
    ).toMatchObject({ error: { code: 'plan_mode' } });
  const cancelled = new AbortController();
  cancelled.abort();
  expect(
    await forwardResourceControl(context(), input('database_status'), cancelled.signal),
  ).toMatchObject({ error: { code: 'cancelled' } });
  expect(fetchMock).not.toHaveBeenCalled();
});
