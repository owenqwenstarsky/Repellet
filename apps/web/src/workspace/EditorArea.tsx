import { lazy, Suspense, type RefObject } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { User, WorkspacePreferences } from '@repellet/shared';
import { X, ChevronRight, Code2 } from 'lucide-react';
import { Spinner, Shortcut } from '../ui';
import { FileIcon } from '../Files';
const CodeEditor = lazy(() => import('../CodeEditor').then((m) => ({ default: m.CodeEditor })));
type Selection = { line: number; column: number };
type Position = WorkspacePreferences['positions'][string];
export function EditorArea({
  projectId,
  projectName,
  user,
  editable,
  tabs,
  active,
  selection,
  positions,
  viewStates,
  onSelect,
  onClose,
  onOpen,
  onPosition,
  onStatus,
  onLanguageStatus,
}: {
  projectId: string;
  projectName: string;
  user: User;
  editable: boolean;
  tabs: string[];
  active: string;
  selection?: Selection;
  positions: RefObject<Record<string, Position>>;
  viewStates: RefObject<Map<string, MonacoEditor.ICodeEditorViewState>>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onOpen: (path: string, line?: number, column?: number) => void;
  onPosition: (path: string, position: Position) => void;
  onStatus: (status: string) => void;
  onLanguageStatus: (status: string) => void;
}) {
  return (
    <section className="editor-stack">
      {tabs.length > 0 && (
        <div className="editor-tabs">
          {tabs.map((path) => (
            <div className={`editor-tab ${active === path ? 'active' : ''}`} key={path}>
              <button aria-pressed={active === path} onClick={() => onSelect(path)}>
                <FileIcon name={path} />
                <span title={path}>{path.split('/').pop()}</span>
              </button>
              <button
                aria-label={`Close ${path}`}
                title="Close"
                className="tab-close"
                onClick={() => onClose(path)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {active ? (
        <>
          <div className="breadcrumbs" title={active} tabIndex={0} aria-label="File path">
            {active.split('/').map((part, i) => (
              <span key={i}>
                {i > 0 && <ChevronRight size={11} />} {part}
              </span>
            ))}
          </div>
          <Suspense fallback={<Spinner label="Opening editor…" />}>
            {tabs.map((path) => (
              <div
                className="retained-editor"
                key={path}
                style={{ display: active === path ? 'flex' : 'none' }}
              >
                <CodeEditor
                  projectId={projectId}
                  path={path}
                  user={user}
                  editable={editable}
                  active={active === path}
                  onStatus={(s) => {
                    if (path === active) onStatus(s);
                  }}
                  onLanguageStatus={(s) => {
                    if (path === active) onLanguageStatus(s);
                  }}
                  viewStates={viewStates.current}
                  onDefinition={onOpen}
                  selection={path === active ? selection : undefined}
                  position={positions.current[path]}
                  onPosition={(pos) => onPosition(path, pos)}
                />
              </div>
            ))}
          </Suspense>
        </>
      ) : (
        <div className="editor-welcome">
          <div className="welcome-mark">
            <Code2 size={40} strokeWidth={1} />
          </div>
          <h2>{projectName}</h2>
          <p>Open a file from the sidebar to start working.</p>
          <div className="shortcut-list">
            <span>
              Open file
              <Shortcut keys={['mod', 'P']} />
            </span>
            <span>
              Find in files
              <Shortcut keys={['mod', 'shift', 'F']} />
            </span>
            {editable && (
              <span>
                Run project
                <Shortcut keys={['mod', 'enter']} />
              </span>
            )}
          </div>
          <small>Changes save automatically.</small>
        </div>
      )}
    </section>
  );
}
