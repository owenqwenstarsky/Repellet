// @vitest-environment jsdom
import { useEffect } from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as Y from 'yjs';
import { CodeEditor } from '../../apps/web/src/CodeEditor';
import { UiProvider } from '../../apps/web/src/ui';
import { user } from './helpers';
const { editor } = vi.hoisted(() => ({
  editor: {
    getModel: () => ({}),
    saveViewState: () => null,
    restoreViewState: vi.fn(),
    getPosition: () => null,
    onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
    onDidScrollChange: () => ({ dispose: vi.fn() }),
    updateOptions: vi.fn(),
  },
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: ({ onMount }: any) => {
    useEffect(() => onMount(editor), []);
    return <div>Monaco rendering</div>;
  },
}));
vi.mock('monaco-editor', () => ({ editor: { defineTheme: vi.fn() } }));
vi.mock('y-monaco', () => ({
  MonacoBinding: class {
    destroy() {}
  },
}));
vi.mock('../../apps/web/src/language', () => ({
  connectLanguage: () => () => {},
  modelUri: () => 'file:///test',
}));
vi.mock('../../apps/web/src/api', () => ({ wsUrl: (s: string) => s, post: vi.fn() }));
it('clears document connection errors on sync and ignores socket callbacks after unmount', async () => {
  let socket: any;
  vi.stubGlobal(
    'WebSocket',
    class {
      readyState = 1;
      onmessage: any;
      onclose: any;
      send() {}
      constructor() {
        socket = this;
      }
      close() {
        this.onclose?.({ code: 1000 });
      }
    },
  );
  const onStatus = vi.fn();
  const view = render(
    <UiProvider>
      <CodeEditor
        projectId="project"
        path="a.ts"
        user={user}
        editable
        onStatus={onStatus}
        onLanguageStatus={vi.fn()}
        viewStates={new Map()}
        onDefinition={vi.fn()}
      />
    </UiProvider>,
  );
  await act(async () => {});
  act(() =>
    socket.onmessage({ data: JSON.stringify({ type: 'error', message: 'Connection failed' }) }),
  );
  expect(screen.getByText('Connection failed')).toBeTruthy();
  const doc = new Y.Doc();
  const update = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
  doc.destroy();
  act(() => socket.onmessage({ data: JSON.stringify({ type: 'sync', update, conflict: false }) }));
  expect(screen.queryByText('Connection failed')).toBeNull();
  const count = onStatus.mock.calls.length;
  view.unmount();
  expect(onStatus).toHaveBeenCalledTimes(count);
});
