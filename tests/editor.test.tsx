// @vitest-environment jsdom
import { useEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { FakeSocket, user } from './web-support';
const mocks = vi.hoisted(() => ({
  editor: null as any,
  language: vi.fn(),
  binding: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('monaco-editor', () => ({ editor: { defineTheme: vi.fn() } }));
vi.mock('monaco-editor/editor/editor.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/language/json/json.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/language/css/css.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/language/html/html.worker?worker', () => ({ default: class {} }));
vi.mock('monaco-editor/language/typescript/ts.worker?worker', () => ({ default: class {} }));
vi.mock('y-monaco', () => ({
  MonacoBinding: class {
    constructor() {
      mocks.binding();
    }
    destroy() {
      mocks.destroy();
    }
  },
}));
vi.mock('../apps/web/src/language', () => ({
  connectLanguage: mocks.language,
  modelUri: (project: string, path: string) => 'file:///repellet/' + project + '/' + path,
}));
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  default: function Editor({ onMount }: any) {
    useEffect(() => onMount(mocks.editor), []);
    return <div>Monaco</div>;
  },
}));
import { CodeEditor } from '../apps/web/src/CodeEditor';
import { UiProvider } from '../apps/web/src/ui';
beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  mocks.editor = {
    getModel: () => ({}),
    getPosition: () => null,
    onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
    onDidScrollChange: () => ({ dispose: vi.fn() }),
    saveViewState: vi.fn(() => ({ cursor: 42, scrollTop: 900 })),
    restoreViewState: vi.fn(),
    updateOptions: vi.fn(),
    setPosition: vi.fn(),
    revealLineInCenter: vi.fn(),
    focus: vi.fn(),
  };
  mocks.language.mockReturnValue(vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const sync = { type: 'sync', update: 'AAA=', conflict: false, dirty: false };
function props(path = 'main.ts', viewStates = new Map()) {
  return {
    projectId: 'project',
    path,
    user,
    editable: true,
    onStatus: vi.fn(),
    onLanguageStatus: vi.fn(),
    onDefinition: vi.fn(),
    viewStates,
  };
}
describe('editor view state and status ownership', () => {
  it('restores saved cursor/scroll state when returning to a tab without resetting to line 1', async () => {
    const viewStates = new Map();
    const first = render(
      <UiProvider>
        <CodeEditor {...props('main.ts', viewStates)} />
      </UiProvider>,
    );
    await act(async () => {});
    first.unmount();
    expect(viewStates.get('main.ts')).toEqual({ cursor: 42, scrollTop: 900 });
    render(
      <UiProvider>
        <CodeEditor {...props('main.ts', viewStates)} />
      </UiProvider>,
    );
    await act(async () => {});
    expect(mocks.editor.restoreViewState).toHaveBeenCalledWith({ cursor: 42, scrollTop: 900 });
    expect(mocks.editor.setPosition).not.toHaveBeenCalled();
  });
  it('clears recovered errors and keeps conflicts authoritative over save acknowledgements and language messages', async () => {
    const values = props();
    const view = render(
      <UiProvider>
        <CodeEditor {...values} />
      </UiProvider>,
    );
    await act(async () => {});
    const socket = FakeSocket.instances[0];
    await act(async () => socket.message(sync));
    expect(values.onStatus).toHaveBeenLastCalledWith('Saved');
    await act(async () => socket.message({ type: 'error', message: 'Write failed' }));
    expect(view.getByText('Write failed')).toBeTruthy();
    expect(values.onStatus).toHaveBeenLastCalledWith('Error');
    await act(async () => socket.message({ type: 'saved' }));
    expect(view.queryByText('Write failed')).toBeNull();
    expect(values.onStatus).toHaveBeenLastCalledWith('Saved');
    await act(async () => socket.message({ type: 'conflict' }));
    await act(async () => socket.message({ type: 'ack', requestId: 'old' }));
    mocks.language.mock.calls[0][3]('Language service ready');
    expect(values.onStatus).toHaveBeenLastCalledWith('Disk conflict');
    expect(values.onLanguageStatus).toHaveBeenCalledWith('Language service ready');
    await act(async () => socket.message({ type: 'resolved' }));
    expect(values.onStatus).toHaveBeenLastCalledWith('Saved');
  });
  it('honors explicit search/definition positions when supplied', async () => {
    render(
      <UiProvider>
        <CodeEditor {...props()} selection={{ line: 17, column: 4 }} />
      </UiProvider>,
    );
    await act(async () => {});
    expect(mocks.editor.setPosition).toHaveBeenCalledWith({ lineNumber: 17, column: 4 });
    expect(mocks.editor.revealLineInCenter).toHaveBeenCalledWith(17);
  });
});
