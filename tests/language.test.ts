// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ts from 'typescript';
import { FakeSocket } from './web-support';
const providers = vi.hoisted(() => ({
  formatting: vi.fn(),
  completion: vi.fn(),
  hover: vi.fn(),
  definition: vi.fn(),
  dispose: vi.fn(),
  markers: vi.fn(),
  completionProviders: new Map<string, any>(),
  hoverProviders: new Map<string, any>(),
  definitionProviders: new Map<string, any>(),
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
import { connectLanguage, connectFormatting } from '../apps/web/src/language';
import { post } from '../apps/web/src/api';
const model = {
  uri: { toString: () => 'file:///repellet/project/main.ts' },
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
  for (const [register, registered] of [
    [providers.completion, providers.completionProviders],
    [providers.hover, providers.hoverProviders],
    [providers.definition, providers.definitionProviders],
  ] as const)
    register.mockImplementation((language, provider) => {
      registered.set(language, provider);
      return { dispose: providers.dispose };
    });
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
function jsxDiagnostics(path: string, languageId: string, content: string) {
  const file = '/workspace/' + path;
  const files = new Map([
    [file, content],
    [
      '/workspace/globals.d.ts',
      `interface Array<T> { length: number; [index: number]: T }
       interface Boolean {} interface Function {} interface IArguments {}
       interface CallableFunction {} interface NewableFunction {}
       interface Number {} interface Object {} interface RegExp {} interface String {}
       declare const document: { getElementById(id: string): unknown };`,
    ],
    [
      '/workspace/node_modules/react-dom/client.d.ts',
      'export function createRoot(container: unknown): { render(element: unknown): void };',
    ],
    [
      '/workspace/node_modules/react/jsx-runtime.d.ts',
      `export namespace JSX {
         interface Element {}
         interface IntrinsicElements { div: { className?: string; children?: unknown } }
       }`,
    ],
  ]);
  // Match the pinned language server's languageId -> script kind conversion.
  const kind =
    languageId === 'typescriptreact'
      ? ts.ScriptKind.TSX
      : languageId === 'javascriptreact'
        ? ts.ScriptKind.JSX
        : languageId === 'javascript'
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  const host: ts.CompilerHost = {
    getSourceFile: (name, target) => {
      const text = files.get(name);
      return text === undefined
        ? undefined
        : ts.createSourceFile(name, text, target, true, name === file ? kind : ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => '/workspace/globals.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/workspace',
    getDirectories: () => [],
    directoryExists: (directory) =>
      [...files.keys()].some((name) => name.startsWith(directory + '/')),
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  return ts.getPreEmitDiagnostics(
    ts.createProgram(
      [file, '/workspace/globals.d.ts'],
      {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX,
        strict: true,
        allowJs: true,
        noEmit: true,
        noLib: true,
      },
      host,
    ),
  );
}
describe('language reconnection', () => {
  it('clears readiness and pending requests, then reopens current text on a new connection', async () => {
    const status = vi.fn();
    const dispose = connectLanguage('project', 'main.ts', model, status, vi.fn());
    const first = FakeSocket.instances[0];
    await initialize(first);
    const hover = providers.hoverProviders.get('typescript').provideHover;
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
describe('workspace language analysis', () => {
  it.each([
    ['src/App.tsx', 'typescript'],
    ['src/App.jsx', 'javascript'],
  ])(
    'parses valid JSX and resolves React imports using the LSP ID sent for %s',
    async (path, language) => {
      const content = `import { createRoot } from 'react-dom/client';
      export const App = () => <div className="app">Hello</div>;
      createRoot(document.getElementById('root')).render(<App />);`;
      const document = {
        ...model,
        uri: { toString: () => `file:///repellet/project/${path}` },
        getLanguageId: () => language,
        getValue: () => content,
      };
      const dispose = connectLanguage('project', path, document, vi.fn(), vi.fn());
      try {
        const socket = FakeSocket.instances[0];
        await initialize(socket);
        const opened = socket.sent.find((item) => item.method === 'textDocument/didOpen').params
          .textDocument;
        expect(
          jsxDiagnostics(path, opened.languageId, opened.text).map((diagnostic) => ({
            code: diagnostic.code,
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          })),
        ).toEqual([]);
        if (language === 'typescript') {
          const diagnostics = jsxDiagnostics(
            path,
            opened.languageId,
            opened.text + '\nconst count: number = "wrong";',
          );
          expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([2322]);
        }
      } finally {
        dispose();
      }
    },
  );

  it.each([
    ['src/React app.tsx', 'typescript', 'typescriptreact'],
    ['src/React app.jsx', 'javascript', 'javascriptreact'],
    ['src/main.ts', 'typescript', 'typescript'],
    ['src/main.js', 'javascript', 'javascript'],
    ['src/main.mjs', 'javascript', 'javascript'],
    ['src/main.cjs', 'javascript', 'javascript'],
    ['src/main.py', 'python', 'python'],
    ['src/main.go', 'go', 'go'],
    ['src/main.rs', 'rust', 'rust'],
  ])(
    'opens and reopens %s with the correct LSP language and URI',
    async (path, language, languageId) => {
      let text = 'initial content';
      const document = {
        ...model,
        uri: { toString: () => `file:///repellet/project/${path}` },
        getLanguageId: () => language,
        getValue: () => text,
      };
      const dispose = connectLanguage('project', path, document, vi.fn(), vi.fn());
      try {
        const first = FakeSocket.instances[0];
        await initialize(first);
        const uri = 'file:///workspace/' + path.split('/').map(encodeURIComponent).join('/');
        expect(first.sent.find((item) => item.method === 'textDocument/didOpen').params).toEqual({
          textDocument: { uri, languageId, version: 1, text },
        });
        first.disconnect();
        text = 'latest content after disconnect';
        await vi.advanceTimersByTimeAsync(2000);
        const second = FakeSocket.instances[1];
        await initialize(second);
        expect(second.sent.find((item) => item.method === 'textDocument/didOpen').params).toEqual({
          textDocument: { uri, languageId, version: 1, text },
        });
      } finally {
        dispose();
      }
    },
  );

  it('shows real server diagnostics, rejects stale versions, and clears markers on disconnect', async () => {
    let change!: () => void;
    const document = {
      ...model,
      onDidChangeContent: (callback: () => void) => {
        change = callback;
        return { dispose: vi.fn() };
      },
    };
    const status = vi.fn();
    const dispose = connectLanguage('project', 'main.ts', document, status, vi.fn());
    try {
      const first = FakeSocket.instances[0];
      await initialize(first);
      const diagnostic = {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        message: "Type 'string' is not assignable to type 'number'.",
        severity: 1,
        source: 'typescript',
        code: 2322,
      };
      const publish = (socket: FakeSocket, version: number) =>
        socket.message({
          method: 'textDocument/publishDiagnostics',
          params: { uri: 'file:///workspace/main.ts', version, diagnostics: [diagnostic] },
        });
      publish(first, 1);
      const marker = {
        startLineNumber: 1,
        startColumn: 7,
        endLineNumber: 1,
        endColumn: 12,
        message: diagnostic.message,
        severity: 8,
        source: 'typescript',
        code: '2322',
      };
      expect(providers.markers).toHaveBeenLastCalledWith(document, 'repellet-lsp', [marker]);
      change();
      providers.markers.mockClear();
      publish(first, 1);
      expect(providers.markers).not.toHaveBeenCalled();
      publish(first, 2);
      expect(providers.markers).toHaveBeenLastCalledWith(document, 'repellet-lsp', [marker]);
      first.disconnect();
      expect(providers.markers).toHaveBeenLastCalledWith(document, 'repellet-lsp', []);
      expect(status).toHaveBeenLastCalledWith('Language service disconnected; retrying…');
      providers.markers.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      const second = FakeSocket.instances[1];
      await initialize(second);
      publish(first, 2);
      expect(providers.markers).not.toHaveBeenCalled();
      publish(second, 2);
      expect(providers.markers).toHaveBeenLastCalledWith(document, 'repellet-lsp', [marker]);
      expect(status).toHaveBeenLastCalledWith('Language service ready');
    } finally {
      dispose();
    }
  });

  it('routes JSX completions, hover, definitions, and formatting through workspace providers', async () => {
    const document = {
      ...model,
      uri: { toString: () => 'file:///repellet/project/src/App.tsx' },
      getWordUntilPosition: () => ({ startColumn: 1, endColumn: 4 }),
    };
    const onDefinition = vi.fn();
    const dispose = connectLanguage('project', 'src/App.tsx', document, vi.fn(), onDefinition);
    try {
      const socket = FakeSocket.instances[0];
      await initialize(socket);
      const position = { lineNumber: 2, column: 3 };
      const completion = providers.completionProviders.get('typescript').provideCompletionItems;
      const hover = providers.hoverProviders.get('typescript').provideHover;
      const definition = providers.definitionProviders.get('typescript').provideDefinition;
      const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } };
      const complete = completion(document, position);
      expect(socket.sent.at(-1)).toMatchObject({
        method: 'textDocument/completion',
        params: {
          textDocument: { uri: 'file:///workspace/src/App.tsx' },
          position: { line: 1, character: 2 },
        },
      });
      socket.message({
        id: socket.sent.at(-1).id,
        result: [{ label: 'App', textEdit: { range, newText: 'App' } }],
      });
      expect((await complete).suggestions).toEqual([
        expect.objectContaining({ label: 'App', insertText: 'App' }),
      ]);
      const hovered = hover(document, position);
      expect(socket.sent.at(-1).method).toBe('textDocument/hover');
      socket.message({ id: socket.sent.at(-1).id, result: { contents: 'workspace hover' } });
      expect((await hovered).contents).toEqual([{ value: 'workspace hover', isTrusted: false }]);
      const defined = definition(document, position);
      expect(socket.sent.at(-1).method).toBe('textDocument/definition');
      socket.message({
        id: socket.sent.at(-1).id,
        result: { uri: 'file:///workspace/src/component.tsx', range },
      });
      expect(await defined).toBeNull();
      expect(onDefinition).toHaveBeenCalledWith('src/component.tsx', 2, 1);
      const format = providers.formatting.mock.calls[0][1].provideDocumentFormattingEdits;
      expect(await format(document)).toEqual([{ range: 'full range', text: 'formatted' }]);
      expect(post).toHaveBeenCalledWith('/projects/project/format', {
        path: 'src/App.tsx',
        content: 'latest content',
      });
      socket.disconnect();
      const sent = socket.sent.length;
      expect(await completion(document, position)).toEqual({ suggestions: [] });
      expect(await hover(document, position)).toBeNull();
      expect(await definition(document, position)).toBeNull();
      expect(socket.sent).toHaveLength(sent);
    } finally {
      dispose();
    }
  });
});
describe('project formatting', () => {
  it('routes formatting to each retained editor through one provider per language', async () => {
    const otherModel = { ...model, getValue: () => 'second document' };
    const closeFirst = connectFormatting('project', 'one.ts', model, vi.fn());
    const closeSecond = connectFormatting('project', 'two.ts', otherModel, vi.fn());
    expect(providers.formatting).toHaveBeenCalledTimes(1);
    const format = providers.formatting.mock.calls[0][1].provideDocumentFormattingEdits;
    await format(model);
    expect(post).toHaveBeenLastCalledWith('/projects/project/format', {
      path: 'one.ts',
      content: 'latest content',
    });
    closeFirst();
    expect(providers.dispose).not.toHaveBeenCalled();
    await format(otherModel);
    expect(post).toHaveBeenLastCalledWith('/projects/project/format', {
      path: 'two.ts',
      content: 'second document',
    });
    closeSecond();
    expect(providers.dispose).toHaveBeenCalled();
  });
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
