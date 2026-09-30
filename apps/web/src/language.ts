import * as monaco from 'monaco-editor';
import { wsUrl, post } from './api';
const toRange = (range: any) => ({
  startLineNumber: range.start.line + 1,
  startColumn: range.start.character + 1,
  endLineNumber: range.end.line + 1,
  endColumn: range.end.character + 1,
});
const toPosition = (position: monaco.Position) => ({
  line: position.lineNumber - 1,
  character: position.column - 1,
});
export function connectLanguage(
  projectId: string,
  path: string,
  model: monaco.editor.ITextModel,
  onStatus: (status: string) => void,
  onDefinition: (path: string, line: number, column: number) => void,
  editable = true,
) {
  const formatting = editable ? connectFormatting(projectId, path, model, onStatus) : () => {};
  const extension = path.split('.').pop() || '';
  const runtime =
    extension === 'py'
      ? 'python'
      : ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(extension)
        ? 'node'
        : extension === 'go'
          ? 'go'
          : extension === 'rs'
            ? 'rust'
            : null;
  if (!runtime) return formatting;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0,
    version = 1,
    ready = false,
    disposed = false;
  const waiting = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const uri = `file:///workspace/${path}`;
  const disposables: monaco.IDisposable[] = [];
  const send = (message: unknown) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  };
  const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params });
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      if (socket.readyState !== 1 || (!ready && method !== 'initialize')) {
        resolve(null);
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('Language request timed out'));
      }, 15000);
      waiting.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  const textDocument = () => ({ uri });
  function clearPending() {
    ready = false;
    for (const item of waiting.values()) {
      clearTimeout(item.timer);
      item.resolve(null);
    }
    waiting.clear();
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'repellet-lsp', []);
  }
  function connect() {
    if (disposed) return;
    clearPending();
    const connection = new WebSocket(
      wsUrl(`/ws/projects/${projectId}/channel?path=${encodeURIComponent('/language/' + runtime)}`),
    );
    socket = connection;
    connection.onmessage = async (event) => {
      if (disposed || socket !== connection) return;
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.method === 'repellet/ready') {
        try {
          const initialized = await request('initialize', {
            processId: null,
            rootUri: 'file:///workspace',
            workspaceFolders: [{ uri: 'file:///workspace', name: 'workspace' }],
            capabilities: {
              textDocument: {
                synchronization: { didSave: true },
                completion: { completionItem: { snippetSupport: true } },
                hover: { contentFormat: ['markdown', 'plaintext'] },
                definition: { linkSupport: true },
                publishDiagnostics: { relatedInformation: true },
              },
            },
          });
          if (
            disposed ||
            socket !== connection ||
            connection.readyState !== 1 ||
            initialized === null
          )
            return;
          ready = true;
          notify('initialized', {});
          notify('textDocument/didOpen', {
            textDocument: {
              uri,
              languageId: model.getLanguageId(),
              version,
              text: model.getValue(),
            },
          });
          onStatus('Language service ready');
        } catch {
          onStatus('Language service unavailable');
        }
        return;
      }
      if (msg.id !== undefined && waiting.has(msg.id)) {
        const item = waiting.get(msg.id)!;
        clearTimeout(item.timer);
        waiting.delete(msg.id);
        msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
        return;
      }
      if (
        msg.method === 'textDocument/publishDiagnostics' &&
        msg.params.uri === uri &&
        !model.isDisposed()
      )
        monaco.editor.setModelMarkers(
          model,
          'repellet-lsp',
          (msg.params.diagnostics || []).map((d: any) => ({
            ...toRange(d.range),
            message: d.message,
            severity:
              d.severity === 1
                ? monaco.MarkerSeverity.Error
                : d.severity === 2
                  ? monaco.MarkerSeverity.Warning
                  : monaco.MarkerSeverity.Info,
            source: d.source,
            code: d.code ? String(d.code) : undefined,
          })),
        );
      else if (msg.method === 'repellet/error') onStatus('Language service unavailable');
      else if (msg.id !== undefined && msg.method) {
        let result: any = null;
        if (msg.method === 'workspace/configuration')
          result = (msg.params.items || []).map(() => ({}));
        send({ jsonrpc: '2.0', id: msg.id, result });
      }
    };
    connection.onclose = (event) => {
      if (disposed || socket !== connection) return;
      clearPending();
      onStatus('Language service disconnected');
      if (event.code !== 1008) reconnect = setTimeout(connect, 2000);
    };
    connection.onerror = () => {
      if (!disposed) onStatus('Language service unavailable');
    };
  }
  connect();
  disposables.push(
    model.onDidChangeContent(() => {
      if (ready)
        notify('textDocument/didChange', {
          textDocument: { uri, version: ++version },
          contentChanges: [{ text: model.getValue() }],
        });
    }),
  );
  const language = model.getLanguageId();
  const active = (m: monaco.editor.ITextModel) => m === model && ready;
  disposables.push(
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '/', ':'],
      provideCompletionItems: async (m, p) => {
        if (!active(m)) return { suggestions: [] };
        try {
          const result = await request('textDocument/completion', {
            textDocument: textDocument(),
            position: toPosition(p),
          });
          const items = Array.isArray(result) ? result : result?.items || [];
          const word = m.getWordUntilPosition(p);
          return {
            suggestions: items.map((item: any) => ({
              label: item.label,
              kind: completionKind(item.kind),
              detail: item.detail,
              documentation:
                typeof item.documentation === 'string'
                  ? item.documentation
                  : item.documentation?.value,
              insertText: item.textEdit?.newText || item.insertText || item.label,
              insertTextRules:
                item.insertTextFormat === 2
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
              range: item.textEdit?.range
                ? toRange(item.textEdit.range)
                : new monaco.Range(p.lineNumber, word.startColumn, p.lineNumber, word.endColumn),
              sortText: item.sortText,
              filterText: item.filterText,
              additionalTextEdits: item.additionalTextEdits?.map((edit: any) => ({
                range: toRange(edit.range),
                text: edit.newText,
              })),
            })),
          };
        } catch {
          return { suggestions: [] };
        }
      },
    }),
  );
  disposables.push(
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (m, p) => {
        if (!active(m)) return null;
        try {
          const result = await request('textDocument/hover', {
            textDocument: textDocument(),
            position: toPosition(p),
          });
          if (!result) return null;
          const values = Array.isArray(result.contents) ? result.contents : [result.contents];
          return {
            range: result.range ? toRange(result.range) : undefined,
            contents: values.map((c: any) => ({
              value:
                typeof c === 'string'
                  ? c
                  : c.language
                    ? `\`\`\`${c.language}\n${c.value}\n\`\`\``
                    : c.value,
              isTrusted: false,
            })),
          };
        } catch {
          return null;
        }
      },
    }),
  );
  disposables.push(
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (m, p) => {
        if (!active(m)) return null;
        try {
          const result = await request('textDocument/definition', {
            textDocument: textDocument(),
            position: toPosition(p),
          });
          const locations = Array.isArray(result) ? result : result ? [result] : [];
          const location = locations[0];
          if (!location) return null;
          const target = location.targetUri || location.uri;
          if (!target.startsWith('file:///workspace/')) return null;
          const range = location.targetSelectionRange || location.range;
          const targetPath = decodeURIComponent(target.slice('file:///workspace/'.length));
          if (targetPath !== path) {
            onDefinition(targetPath, range.start.line + 1, range.start.character + 1);
            return null;
          }
          return { uri: model.uri, range: toRange(range) };
        } catch {
          return null;
        }
      },
    }),
  );
  onStatus('Starting language service…');
  return () => {
    disposed = true;
    clearTimeout(reconnect);
    formatting();
    notify('textDocument/didClose', { textDocument: textDocument() });
    socket.close();
    clearPending();
    disposables.forEach((d) => d.dispose());
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'repellet-lsp', []);
  };
}
function completionKind(kind: number) {
  const kinds = [
    monaco.languages.CompletionItemKind.Text,
    monaco.languages.CompletionItemKind.Method,
    monaco.languages.CompletionItemKind.Function,
    monaco.languages.CompletionItemKind.Constructor,
    monaco.languages.CompletionItemKind.Field,
    monaco.languages.CompletionItemKind.Variable,
    monaco.languages.CompletionItemKind.Class,
    monaco.languages.CompletionItemKind.Interface,
    monaco.languages.CompletionItemKind.Module,
    monaco.languages.CompletionItemKind.Property,
    monaco.languages.CompletionItemKind.Unit,
    monaco.languages.CompletionItemKind.Value,
    monaco.languages.CompletionItemKind.Enum,
    monaco.languages.CompletionItemKind.Keyword,
    monaco.languages.CompletionItemKind.Snippet,
    monaco.languages.CompletionItemKind.Color,
    monaco.languages.CompletionItemKind.File,
    monaco.languages.CompletionItemKind.Reference,
    monaco.languages.CompletionItemKind.Folder,
    monaco.languages.CompletionItemKind.EnumMember,
    monaco.languages.CompletionItemKind.Constant,
    monaco.languages.CompletionItemKind.Struct,
    monaco.languages.CompletionItemKind.Event,
    monaco.languages.CompletionItemKind.Operator,
    monaco.languages.CompletionItemKind.TypeParameter,
  ];
  return kinds[kind - 1] ?? monaco.languages.CompletionItemKind.Text;
}

export function connectFormatting(
  projectId: string,
  path: string,
  model: monaco.editor.ITextModel,
  onStatus: (status: string) => void,
) {
  const language = model.getLanguageId();
  let disposed = false;
  const provider = monaco.languages.registerDocumentFormattingEditProvider(language, {
    provideDocumentFormattingEdits: async (m) => {
      if (m !== model || disposed) return [];
      const revision = m.getVersionId();
      try {
        const result = await post<{ content: string }>(`/projects/${projectId}/format`, {
          path,
          content: m.getValue(),
        });
        if (disposed || m.isDisposed() || m.getVersionId() !== revision) return [];
        return [{ range: m.getFullModelRange(), text: result.content }];
      } catch (e) {
        onStatus(e instanceof Error ? e.message : 'Formatting failed');
        return [];
      }
    },
  });
  return () => {
    disposed = true;
    provider.dispose();
  };
}
