import { useEffect, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import type { User } from '@repellet/shared';
import { registerDocumentSave } from './documentSaves';
import { wsUrl, post } from './api';
import { connectLanguage, modelUri } from './language';
import { useUi, Spinner } from './ui';
import { AlertTriangle } from 'lucide-react';
(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    return label === 'json'
      ? new JsonWorker()
      : ['css', 'scss', 'less'].includes(label)
        ? new CssWorker()
        : ['html', 'handlebars', 'razor'].includes(label)
          ? new HtmlWorker()
          : ['typescript', 'javascript'].includes(label)
            ? new TsWorker()
            : new EditorWorker();
  },
};
loader.config({ monaco });
monaco.editor.defineTheme('repellet', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8992A0' },
    { token: 'keyword', foreground: 'BAA2D2' },
    { token: 'string', foreground: 'A1BE8D' },
    { token: 'number', foreground: 'D2AC7E' },
    { token: 'type', foreground: '8ABEC9' },
  ],
  colors: {
    'editor.background': '#17191d',
    'editor.foreground': '#cbd0d9',
    'editorLineNumber.foreground': '#8992a0',
    'editorLineNumber.activeForeground': '#abb3bf',
    'editor.selectionBackground': '#31444d',
    'editor.inactiveSelectionBackground': '#2b343d',
    'editor.lineHighlightBackground': '#1d2026',
    'editorCursor.foreground': '#83bcc5',
    'editorIndentGuide.background1': '#282c33',
    'editorWidget.background': '#20232a',
    'editorWidget.border': '#343941',
  },
});
const fromB64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toB64 = (value: Uint8Array) => {
  let s = '';
  for (const byte of value) s += String.fromCharCode(byte);
  return btoa(s);
};
function language(path: string) {
  const ext = path.split('.').pop();
  return (
    {
      py: 'python',
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      go: 'go',
      rs: 'rust',
      json: 'json',
      html: 'html',
      css: 'css',
      md: 'markdown',
      yml: 'yaml',
      yaml: 'yaml',
      sh: 'shell',
      toml: 'ini',
    }[ext as 'py'] || 'plaintext'
  );
}
export function CodeEditor({
  projectId,
  path,
  user,
  editable,
  onStatus,
  onLanguageStatus,
  viewStates,
  onDefinition,
  selection,
  position,
  onPosition,
  active = true,
}: {
  projectId: string;
  path: string;
  user: User;
  editable: boolean;
  onStatus: (s: string) => void;
  onLanguageStatus: (s: string) => void;
  viewStates: Map<string, monaco.editor.ICodeEditorViewState>;
  onDefinition: (path: string, line: number, column: number) => void;
  selection?: { line: number; column: number };
  position?: { line: number; column: number; scrollTop: number; scrollLeft: number };
  onPosition?: (value: {
    line: number;
    column: number;
    scrollTop: number;
    scrollLeft: number;
  }) => void;
  active?: boolean;
}) {
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [conflict, setConflict] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const ui = useUi();
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const positionCallback = useRef(onPosition);
  positionCallback.current = onPosition;
  const initialPosition = useRef(position);
  const status = useRef(onStatus);
  status.current = onStatus;
  const languageStatus = useRef(onLanguageStatus);
  languageStatus.current = onLanguageStatus;
  useEffect(() => {
    if (!editor) return;
    const saved = viewStates.get(path);
    if (saved) editor.restoreViewState(saved);
    return () => {
      const state = editor.saveViewState();
      if (state) viewStates.set(path, state);
    };
  }, [editor, path, viewStates]);
  useEffect(() => {
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const recordPosition = () => {
      const pos = editor.getPosition();
      if (pos)
        positionCallback.current?.({
          line: pos.lineNumber,
          column: pos.column,
          scrollTop: editor.getScrollTop(),
          scrollLeft: editor.getScrollLeft(),
        });
    };
    const cursorSubscription = editor.onDidChangeCursorPosition(recordPosition);
    const scrollSubscription = editor.onDidScrollChange(recordPosition);
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const color = ['#85bbc4', '#ba9cce', '#d8b083', '#92b894'][user.id.charCodeAt(0) % 4]!;
    awareness.setLocalStateField('user', { name: user.displayName, color });
    let socket: WebSocket | null = null,
      binding: MonacoBinding | null = null,
      languageDispose: (() => void) | null = null,
      timer: ReturnType<typeof setTimeout> | undefined,
      disposed = false,
      synced = false,
      diskConflict = false,
      documentError = '',
      online = false;
    languageStatus.current('');
    status.current('Connecting…');
    const pending = new Map<string, string>();
    const waits = new Set<{
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    const acknowledge = () => {
      if (!pending.size)
        for (const wait of waits) {
          clearTimeout(wait.timer);
          waits.delete(wait);
          wait.resolve();
        }
    };
    const unregisterSave = registerDocumentSave(
      projectId,
      path,
      () =>
        new Promise<void>((resolve, reject) => {
          if (!pending.size) {
            resolve();
            return;
          }
          if (conflictRef.current) {
            reject(new Error('Resolve disk conflicts before Run.'));
            return;
          }
          const wait = {
            resolve,
            reject,
            timer: setTimeout(() => {
              waits.delete(wait);
              reject(new Error('Edits are still waiting for the server. Reconnect before Run.'));
            }, 15000),
          };
          waits.add(wait);
        }),
    );
    let sequence = 0;
    const publish = (value: string) =>
      status.current(
        documentError
          ? 'Error'
          : diskConflict
            ? 'Disk conflict'
            : !online
              ? 'Reconnecting…'
              : pending.size
                ? 'Saving…'
                : value,
      );
    const send = (message: unknown) => {
      if (socket?.readyState === 1) socket.send(JSON.stringify(message));
    };
    const update = (data: Uint8Array, origin: unknown) => {
      if (origin === 'server' || !editable || !synced) return;
      const requestId = String(++sequence),
        encoded = toB64(data);
      pending.set(requestId, encoded);
      send({ type: 'update', update: encoded, requestId });
      publish('Saving…');
    };
    doc.on('update', update);
    const awarenessUpdate = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin !== 'server')
        send({
          type: 'awareness',
          update: toB64(encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])),
        });
    };
    awareness.on('update', awarenessUpdate);
    function connect() {
      if (disposed) return;
      socket = new WebSocket(
        wsUrl(`/ws/projects/${projectId}/document?path=${encodeURIComponent(path)}`),
      );
      socket.onmessage = (event) => {
        if (disposed) return;
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'sync') {
          setError('');
          Y.applyUpdate(doc, fromB64(msg.update), 'server');
          synced = true;
          diskConflict = !!msg.conflict;
          online = true;
          documentError = '';
          setError('');
          setConflict(msg.conflict);
          setConnected(true);
          if (!binding)
            binding = new MonacoBinding(
              doc.getText('content'),
              model!,
              new Set([editor!]),
              awareness,
            );
          editor!.updateOptions({ readOnly: !editable });
          for (const [requestId, data] of pending)
            send({ type: 'update', update: data, requestId });
          send({
            type: 'awareness',
            update: toB64(encodeAwarenessUpdate(awareness, [doc.clientID])),
          });
          if (!languageDispose)
            languageDispose = connectLanguage(
              projectId,
              path,
              model!,
              (s) => languageStatus.current(s),
              onDefinition,
              editable,
            );
          if (initialPosition.current) {
            const pos = initialPosition.current;
            initialPosition.current = undefined;
            editor!.setPosition({ lineNumber: pos.line, column: pos.column });
            editor!.setScrollPosition({ scrollTop: pos.scrollTop, scrollLeft: pos.scrollLeft });
          }
          publish(msg.dirty ? 'Saving…' : 'Saved');
        } else if (msg.type === 'update') Y.applyUpdate(doc, fromB64(msg.update), 'server');
        else if (msg.type === 'awareness')
          applyAwarenessUpdate(awareness, fromB64(msg.update), 'server');
        else if (msg.type === 'ack') {
          pending.delete(msg.requestId);
          acknowledge();
          publish('Saved to server');
        } else if (msg.type === 'saved') {
          documentError = '';
          setError('');
          publish('Saved');
        } else if (msg.type === 'conflict') {
          diskConflict = true;
          setConflict(true);
          publish('Disk conflict');
        } else if (msg.type === 'resolved') {
          diskConflict = false;
          documentError = '';
          setError('');
          setConflict(false);
          publish('Saved');
        } else if (msg.type === 'error') {
          documentError = msg.message;
          setError(msg.message);
          status.current('Error');
        }
      };
      socket.onclose = (e) => {
        if (disposed) return;
        online = false;
        synced = false;
        setConnected(false);
        editor?.updateOptions({ readOnly: true });
        if (e.code === 1008) {
          documentError = e.reason || 'Access changed. Reopen this file.';
          setError(documentError);
          publish('Error');
          return;
        }
        publish('Reconnecting…');
        if (!disposed) timer = setTimeout(connect, 2000);
      };
      socket.onerror = () => {
        if (!disposed) publish('Connection interrupted');
      };
    }
    editor.updateOptions({ readOnly: true });
    connect();
    return () => {
      disposed = true;
      cursorSubscription.dispose();
      scrollSubscription.dispose();
      clearTimeout(timer);
      unregisterSave();
      for (const wait of waits) {
        clearTimeout(wait.timer);
        wait.reject(new Error('Document closed while waiting for edits to save'));
      }
      languageDispose?.();
      binding?.destroy();
      doc.off('update', update);
      awareness.off('update', awarenessUpdate);
      awareness.destroy();
      socket?.close();
      doc.destroy();
    };
  }, [editor, projectId, path, user.id, editable]);
  useEffect(() => {
    if (editor && selection && active) {
      editor.setPosition({ lineNumber: selection.line, column: selection.column });
      editor.revealLineInCenter(selection.line);
      editor.focus();
    }
  }, [editor, selection, active]);
  return (
    <div className="code-editor">
      {conflict && (
        <div className="conflict-banner" role="alert">
          <AlertTriangle size={17} />
          <span>This file changed on disk. Autosave is paused.</span>
          {editable && (
            <>
              <button
                onClick={() =>
                  post(`/projects/${projectId}/conflict`, { path, choice: 'disk' }).catch((e) =>
                    ui.notify(e.message),
                  )
                }
              >
                Reload from disk
              </button>
              <button
                onClick={() =>
                  post(`/projects/${projectId}/conflict`, { path, choice: 'editor' }).catch((e) =>
                    ui.notify(e.message),
                  )
                }
              >
                Keep editor content
              </button>
            </>
          )}
        </div>
      )}
      {error && <div className="form-error editor-error">{error}</div>}
      <Editor
        path={modelUri(projectId, path)}
        saveViewState={false}
        language={language(path)}
        theme="repellet"
        onMount={setEditor as OnMount}
        loading={<Spinner label="Opening editor…" />}
        options={{
          editContext: false,
          fontSize: 13,
          fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
          lineHeight: 22,
          minimap: { enabled: false },
          padding: { top: 18, bottom: 18 },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          tabSize: 2,
          readOnly: !editable || !connected,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          renderLineHighlight: 'line',
          bracketPairColorization: { enabled: true },
          overviewRulerBorder: false,
          fixedOverflowWidgets: true,
        }}
      />
      <div
        className={`connection-indicator ${connected ? 'connected' : ''}`}
        title={connected ? 'Live document connected' : 'Document disconnected'}
      />
    </div>
  );
}
