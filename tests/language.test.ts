// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeSocket } from './web-support';
const providers = vi.hoisted(() => ({
  formatting: vi.fn(),
  completion: vi.fn(),
  hover: vi.fn(),
  definition: vi.fn(),
  dispose: vi.fn(),
  markers: vi.fn(),
}));
vi.mock('monaco-editor', () => ({
  editor: { setModelMarkers: providers.markers },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  languages: {
    registerDocumentFormattingEditProvider: providers.formatting,
    registerCompletionItemProvider: providers.completion,
    registerHoverProvider: providers.hover,
    registerDefinitionProvider: providers.definition,
    CompletionItemKind: {},
  },
}));
vi.mock('../apps/web/src/api', () => ({ wsUrl: (s: string) => s, post: vi.fn() }));
import { connectLanguage } from '../apps/web/src/language';
import { post } from '../apps/web/src/api';
const model = {
  getLanguageId: () => 'typescript',
  getValue: () => 'latest content',
  getVersionId: () => 1,
  getFullModelRange: () => 'full range',
  isDisposed: () => false,
  onDidChangeContent: () => ({ dispose: vi.fn() }),
} as any;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  for (const provider of [
    providers.formatting,
    providers.completion,
    providers.hover,
    providers.definition,
  ])
    provider.mockReturnValue({ dispose: providers.dispose });
  vi.mocked(post).mockResolvedValue({ content: 'formatted' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function initialize(socket: FakeSocket) {
  const ready = socket.message({ method: 'repellet/ready' });
  const request = socket.sent.findLast((item) => item.method === 'initialize');
  socket.message({ id: request.id, result: { capabilities: {} } });
  await ready;
}
describe('language reconnection', () => {
  it('clears readiness and pending requests, then reopens current text on a new connection', async () => {
    const status = vi.fn();
    const dispose = connectLanguage('project', 'main.ts', model, status, vi.fn());
    const first = FakeSocket.instances[0];
    await initialize(first);
    const hover = providers.hover.mock.calls[0][1].provideHover;
    const pending = hover(model, { lineNumber: 1, column: 1 });
    first.disconnect();
    expect(await pending).toBeNull();
    const before = first.sent.length;
    expect(await hover(model, { lineNumber: 1, column: 1 })).toBeNull();
    expect(first.sent.length).toBe(before);
    await vi.advanceTimersByTimeAsync(2000);
    const second = FakeSocket.instances[1];
    await initialize(second);
    expect(
      second.sent.find((item) => item.method === 'textDocument/didOpen').params.textDocument.text,
    ).toBe('latest content');
    const recovered = hover(model, { lineNumber: 1, column: 1 });
    second.message({ id: second.sent.at(-1).id, result: { contents: 'hover restored' } });
    expect((await recovered).contents[0].value).toBe('hover restored');
    dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
  it('does not reconnect after access is revoked', async () => {
    const dispose = connectLanguage('project', 'main.ts', model, vi.fn(), vi.fn());
    FakeSocket.instances[0].disconnect(1008);
    await vi.advanceTimersByTimeAsync(10000);
    expect(FakeSocket.instances).toHaveLength(1);
    dispose();
  });
});
describe('project formatting', () => {
  for (const path of ['README.md', 'config.json', 'style.css', 'index.html'])
    it(`registers formatting without a runtime for ${path}`, async () => {
      const dispose = connectLanguage('project', path, model, vi.fn(), vi.fn());
      expect(FakeSocket.instances).toHaveLength(0);
      const format = providers.formatting.mock.calls[0][1].provideDocumentFormattingEdits;
      expect(await format(model)).toEqual([{ range: 'full range', text: 'formatted' }]);
      expect(post).toHaveBeenCalledWith('/projects/project/format', {
        path,
        content: 'latest content',
      });
      dispose();
      expect(providers.dispose).toHaveBeenCalled();
    });
  it('does not register project formatting for read-only files', () => {
    const dispose = connectLanguage('project', 'README.md', model, vi.fn(), vi.fn(), false);
    expect(providers.formatting).not.toHaveBeenCalled();
    dispose();
  });
});
