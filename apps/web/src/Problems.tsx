import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
import { modelUri, languageStates } from './language';
import type { OpenFileDiagnostic } from '@repellet/shared';
export function Problems({
  projectId,
  tabs,
  onOpen,
}: {
  projectId: string;
  tabs: string[];
  onOpen: (path: string, line: number, column: number) => void;
}) {
  const [diagnostics, setDiagnostics] = useState<OpenFileDiagnostic[]>([]),
    [services, setServices] = useState(languageStates(projectId));
  useEffect(() => {
    const update = () => {
      setDiagnostics(
        tabs
          .flatMap((path) =>
            monaco.editor
              .getModelMarkers({ resource: monaco.Uri.parse(modelUri(projectId, path)) })
              .map((d) => ({
                path,
                severity: d.severity,
                message: d.message,
                line: d.startLineNumber,
                column: d.startColumn,
              })),
          )
          .sort(
            (a, b) => a.path.localeCompare(b.path) || b.severity - a.severity || a.line - b.line,
          ),
      );
      setServices(languageStates(projectId));
    };
    update();
    const subscription = monaco.editor.onDidChangeMarkers(update);
    window.addEventListener('repellet:language-state', update);
    return () => {
      subscription.dispose();
      window.removeEventListener('repellet:language-state', update);
    };
  }, [projectId, tabs]);
  return (
    <div className="problems-pane">
      <div className="pane-heading">Open files</div>
      {services.map((s) => (
        <p className="field-help" key={s.runtime}>
          {s.runtime}: {s.status}
        </p>
      ))}
      {!services.length && (
        <p className="field-help">Open a supported source file to start its language service.</p>
      )}
      {tabs.map((path) => {
        const items = diagnostics.filter((d) => d.path === path);
        return items.length ? (
          <section key={path}>
            <strong>{path}</strong>
            {items.map((d, i) => (
              <button key={i} onClick={() => onOpen(d.path, d.line, d.column)}>
                <span>
                  {d.severity === 8 ? 'Error' : d.severity === 4 ? 'Warning' : 'Info'} · {d.line}:
                  {d.column}
                </span>
                {d.message}
              </button>
            ))}
          </section>
        ) : null;
      })}
      {!diagnostics.length && (
        <p className="pane-empty-text">No problems reported in open files.</p>
      )}
      <p className="field-help">Use the terminal for full-project lint and type checks.</p>
    </div>
  );
}
