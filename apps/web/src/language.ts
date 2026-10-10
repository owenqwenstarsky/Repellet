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
type Document = {
  projectId: string;
  path: string;
  model: monaco.editor.ITextModel;
  version: number;
  onStatus: (status: string) => void;
  onDefinition: (path: string, line: number, column: number) => void;
  service: Service;
};
const documents = new Map<string, Document>();
const services = new Map<string, Service>();
const registrations: monaco.IDisposable[] = [];
const languages = new Set<string>();
const states = new Map<string, string>();
const serverUri = (path: string) =>
  'file:///workspace/' + path.split('/').map(encodeURIComponent).join('/');
export const modelUri = (project: string, path: string) =>
  `file:///repellet/${project}/${path.split('/').map(encodeURIComponent).join('/')}`;
function publish(service: Service, state: string) {
  states.set(service.key, state);
  window.dispatchEvent(new Event('repellet:language-state'));
  for (const doc of service.docs.values()) doc.onStatus(state);
}
export function languageStates(project: string) {
  return [...states]
    .filter(([key]) => key.startsWith(project + ':'))
    .map(([key, status]) => ({ runtime: key.split(':')[1]!, status }));
}
class Service {
  socket?: WebSocket;
  ready = false;
  disposed = false;
  sequence = 0;
  retry?: ReturnType<typeof setTimeout>;
  docs = new Map<string, Document>();
  waiting = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    public key: string,
    public project: string,
    public runtime: string,
  ) {
    this.connect();
  }
  send(message: unknown) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
  notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.socket?.readyState !== 1 || (!this.ready && method !== 'initialize'))
      return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('Language request timed out'));
      }, 15000);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  open(doc: Document) {
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri: serverUri(doc.path),
        languageId: doc.path.endsWith('.tsx')
          ? 'typescriptreact'
          : doc.path.endsWith('.jsx')
            ? 'javascriptreact'
            : doc.model.getLanguageId(),
        version: doc.version,
        text: doc.model.getValue(),
      },
    });
  }
  clear() {
    this.ready = false;
    for (const doc of this.docs.values())
      if (!doc.model.isDisposed()) monaco.editor.setModelMarkers(doc.model, 'repellet-lsp', []);
    for (const item of this.waiting.values()) {
      clearTimeout(item.timer);
      item.resolve(null);
    }
    this.waiting.clear();
  }
  connect() {
    if (this.disposed) return;
    publish(this, 'Starting language service…');
    const socket = new WebSocket(
      wsUrl(
        `/ws/projects/${this.project}/channel?path=${encodeURIComponent('/language/' + this.runtime)}`,
      ),
    );
    this.socket = socket;
    socket.onmessage = async (event) => {
      if (this.disposed || socket !== this.socket) return;
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.method === 'repellet/ready') {
        try {
          const initialized = await this.request('initialize', {
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
            this.disposed ||
            socket !== this.socket ||
            socket.readyState !== 1 ||
            initialized === null
          )
            return;
          this.ready = true;
          this.notify('initialized', {});
          for (const doc of this.docs.values()) this.open(doc);
          publish(this, 'Language service ready');
        } catch {
          publish(this, 'Language service unavailable');
        }
        return;
      }
      if (msg.id !== undefined && this.waiting.has(msg.id)) {
        const item = this.waiting.get(msg.id)!;
        clearTimeout(item.timer);
        this.waiting.delete(msg.id);
        msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
        return;
      }
      if (msg.method === 'textDocument/publishDiagnostics') {
        const doc = [...this.docs.values()].find((doc) => serverUri(doc.path) === msg.params.uri);
        if (
          !doc ||
          doc.model.isDisposed() ||
          (msg.params.version !== undefined && msg.params.version < doc.version)
        )
          return;
        monaco.editor.setModelMarkers(
          doc.model,
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
      } else if (msg.method === 'repellet/error') {
        this.clear();
        publish(this, 'Language service unavailable');
      } else if (msg.id !== undefined && msg.method)
        this.send({
          jsonrpc: '2.0',
          id: msg.id,
          result:
            msg.method === 'workspace/configuration'
              ? (msg.params.items || []).map(() => ({}))
              : null,
        });
    };
    socket.onclose = (event) => {
      if (this.disposed || socket !== this.socket) return;
      this.clear();
      publish(this, 'Language service disconnected; retrying…');
      if (event.code !== 1008) this.retry = setTimeout(() => this.connect(), 2000);
    };
    socket.onerror = () => publish(this, 'Language service unavailable');
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    this.clear();
    this.socket?.close();
    services.delete(this.key);
    states.delete(this.key);
    window.dispatchEvent(new Event('repellet:language-state'));
  }
}
export function connectLanguage(
  projectId: string,
  path: string,
  model: monaco.editor.ITextModel,
  onStatus: (status: string) => void,
  onDefinition: (path: string, line: number, column: number) => void,
  editable = true,
) {
  const formatting = editable ? connectFormatting(projectId, path, model, onStatus) : () => {};
  const ext = path.split('.').pop();
  const runtime =
    ext === 'py'
      ? 'python'
      : ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].includes(ext || '')
        ? 'node'
        : ext === 'go'
          ? 'go'
          : ext === 'rs'
            ? 'rust'
            : null;
  if (!runtime) return formatting;
  const key = projectId + ':' + runtime;
  let service = services.get(key);
  if (!service) {
    service = new Service(key, projectId, runtime);
    services.set(key, service);
  }
  const doc: Document = { projectId, path, model, onStatus, onDefinition, service, version: 1 };
  documents.set(model.uri.toString(), doc);
  service.docs.set(path, doc);
  if (service.ready) service.open(doc);
  const changed = model.onDidChangeContent(() => {
    doc.version++;
    if (service!.ready)
      service!.notify('textDocument/didChange', {
        textDocument: { uri: serverUri(path), version: doc.version },
        contentChanges: [{ text: model.getValue() }],
      });
  });
  registerProviders(model.getLanguageId());
  return () => {
    formatting();
    changed.dispose();
    if (service!.ready)
      service!.notify('textDocument/didClose', { textDocument: { uri: serverUri(path) } });
    service!.docs.delete(path);
    documents.delete(model.uri.toString());
    if (!model.isDisposed()) monaco.editor.setModelMarkers(model, 'repellet-lsp', []);
    if (!service!.docs.size) service!.dispose();
  };
}
function registerProviders(language: string) {
  if (languages.has(language)) return;
  languages.add(language);
  registrations.push(
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '/', ':'],
      provideCompletionItems: async (m, p) => {
        const doc = documents.get(m.uri.toString());
        if (!doc) return null as any;
        const { model, path, projectId, onStatus, onDefinition, service } = doc;
        const ready = service.ready;
        const active = (candidate: monaco.editor.ITextModel) => candidate === model && ready;
        const request = (method: string, params: unknown) => service.request(method, params);
        const textDocument = () => ({ uri: serverUri(path) });

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
  registrations.push(
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (m, p) => {
        const doc = documents.get(m.uri.toString());
        if (!doc) return null as any;
        const { model, path, projectId, onStatus, onDefinition, service } = doc;
        const ready = service.ready;
        const active = (candidate: monaco.editor.ITextModel) => candidate === model && ready;
        const request = (method: string, params: unknown) => service.request(method, params);
        const textDocument = () => ({ uri: serverUri(path) });

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
  registrations.push(
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (m, p) => {
        const doc = documents.get(m.uri.toString());
        if (!doc) return null as any;
        const { model, path, projectId, onStatus, onDefinition, service } = doc;
        const ready = service.ready;
        const active = (candidate: monaco.editor.ITextModel) => candidate === model && ready;
        const request = (method: string, params: unknown) => service.request(method, params);
        const textDocument = () => ({ uri: serverUri(path) });

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

const formattingDocuments = new Map<
  monaco.editor.ITextModel,
  { projectId: string; path: string; onStatus: (status: string) => void }
>();
const formattingProviders = new Map<string, monaco.IDisposable>();
export function connectFormatting(
  projectId: string,
  path: string,
  model: monaco.editor.ITextModel,
  onStatus: (status: string) => void,
) {
  const language = model.getLanguageId();
  const document = { projectId, path, onStatus };
  formattingDocuments.set(model, document);
  if (!formattingProviders.has(language)) {
    const provider = monaco.languages.registerDocumentFormattingEditProvider(language, {
      provideDocumentFormattingEdits: async (m) => {
        const document = formattingDocuments.get(m);
        if (!document) return [];
        const { projectId, path, onStatus } = document;
        const revision = m.getVersionId();
        try {
          const result = await post<{ content: string }>(`/projects/${projectId}/format`, {
            path,
            content: m.getValue(),
          });
          if (
            formattingDocuments.get(m) !== document ||
            m.isDisposed() ||
            m.getVersionId() !== revision
          )
            return [];
          return [{ range: m.getFullModelRange(), text: result.content }];
        } catch (e) {
          onStatus(e instanceof Error ? e.message : 'Formatting failed');
          return [];
        }
      },
    });
    formattingProviders.set(language, provider);
  }
  return () => {
    if (formattingDocuments.get(model) === document) formattingDocuments.delete(model);
    if (![...formattingDocuments.keys()].some((m) => m.getLanguageId() === language)) {
      formattingProviders.get(language)?.dispose();
      formattingProviders.delete(language);
    }
  };
}
