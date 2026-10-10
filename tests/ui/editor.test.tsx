// @vitest-environment jsdom
import { useEffect } from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import * as Y from 'yjs';
import { CodeEditor } from '../../apps/web/src/CodeEditor';
import { UiProvider } from '../../apps/web/src/ui';
import { user } from './helpers';
const { editor, bind } = vi.hoisted(() => ({
  bind: vi.fn(),
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
vi.mock('monaco-editor', () => ({
  editor: { defineTheme: vi.fn() },
  typescript: {
    typescriptDefaults: { setModeConfiguration: vi.fn() },
    javascriptDefaults: { setModeConfiguration: vi.fn() },
  },
}));
vi.mock('y-monaco', () => ({
  MonacoBinding: class {
    constructor(...args: unknown[]) {
      bind(...args);
    }
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
  const onInitialLoad = vi.fn();
  const view = render(
    <UiProvider>
      <CodeEditor
        projectId="project"
        path="a.ts"
        user={user}
        editable
        onStatus={onStatus}
        onInitialLoad={onInitialLoad}
        onLanguageStatus={vi.fn()}
        viewStates={new Map()}
        onDefinition={vi.fn()}
      />
    </UiProvider>,
  );
  await act(async () => {});
  expect(onInitialLoad).not.toHaveBeenCalled();
  act(() =>
    socket.onmessage({ data: JSON.stringify({ type: 'error', message: 'Connection failed' }) }),
  );
  expect(screen.getByText('Connection failed')).toBeTruthy();
  expect(onInitialLoad).toHaveBeenLastCalledWith('Connection failed');
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'const loaded = true;');
  const update = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
  doc.destroy();
  act(() => socket.onmessage({ data: JSON.stringify({ type: 'sync', update, conflict: false }) }));
  expect(screen.queryByText('Connection failed')).toBeNull();
  expect(onInitialLoad).toHaveBeenLastCalledWith();
  expect(bind.mock.calls.at(-1)?.[0].toString()).toBe('const loaded = true;');
  expect(bind.mock.invocationCallOrder.at(-1)).toBeLessThan(
    onInitialLoad.mock.invocationCallOrder.at(-1)!,
  );
  const count = onStatus.mock.calls.length;
  const initializationCount = onInitialLoad.mock.calls.length;
  view.unmount();
  act(() => socket.onmessage({ data: JSON.stringify({ type: 'error', message: 'Stale error' }) }));
  expect(onStatus).toHaveBeenCalledTimes(count);
  expect(onInitialLoad).toHaveBeenCalledTimes(initializationCount);
});
