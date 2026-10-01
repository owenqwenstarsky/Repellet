import { useEffect, useState } from 'react';
import * as monaco from 'monaco-editor';
import { modelUri, languageStates } from './language';
import type { OpenFileDiagnostic } from '@repellet/shared';
import { PaneHeader } from './ui';
const severity = (s: number) => (s === 8 ? 'error' : s === 4 ? 'warning' : 'info');
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
      <PaneHeader title="Problems" />
      <div className="problems-services">
        {services.map((s) => (
          <span key={s.runtime}>
            {s.runtime}: {s.status}
          </span>
        ))}
        {!services.length && <span>Open a source file to start its language service.</span>}
      </div>
      {tabs.map((path) => {
        const items = diagnostics.filter((d) => d.path === path);
        return items.length ? (
          <section key={path}>
            <strong className="truncate" title={path}>
              {path}
            </strong>
            {items.map((d, i) => (
              <button
                key={i}
                className={severity(d.severity)}
                onClick={() => onOpen(d.path, d.line, d.column)}
              >
                <span>
                  {severity(d.severity)} · {d.line}:{d.column}
                </span>
                {d.message}
              </button>
            ))}
          </section>
        ) : null;
      })}
      {!diagnostics.length && <p className="pane-empty-text">No problems in open files.</p>}
      <p className="pane-footnote">
        Only open files are checked. Use the terminal for full-project lint and type checks.
      </p>
    </div>
  );
}
