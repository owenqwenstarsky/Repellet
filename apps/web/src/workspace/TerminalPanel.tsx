import { Play, Plus, X } from 'lucide-react';
import type { TerminalInfo } from '@repellet/shared';
import { IconButton, LoadError } from '../ui';
import { Terminal } from '../Terminal';
export function TerminalPanel({
  projectId,
  visible,
  terminals,
  terminal,
  error,
  editable,
  onSelect,
  onStop,
  onCreate,
  onRetry,
}: {
  projectId: string;
  visible: boolean;
  terminals: TerminalInfo[];
  terminal: string;
  error: string;
  editable: boolean;
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}) {
  const orderedTerminals = [...terminals].sort(
    (a, b) => Number(b.id === 'run') - Number(a.id === 'run'),
  );
  return (
    <section className="terminal-panel">
      <div className="terminal-content">
        {error && <LoadError message={error} onRetry={onRetry} />}
        {terminal ? (
          <Terminal
            key={terminal}
            projectId={projectId}
            id={terminal}
            editable={editable}
            visible={visible}
          />
        ) : (
          <div className="terminal-empty">
            {editable
              ? 'Create a terminal with + to get started.'
              : 'No terminal sessions are running.'}
          </div>
        )}
      </div>
      <aside className="terminal-sidebar" aria-label="Terminal sessions">
        <div className="terminal-toolbar">
          <span className="pane-title">Sessions</span>
          {editable && (
            <IconButton
              size="sm"
              label="New terminal"
              icon={<Plus size={14} />}
              onClick={onCreate}
            />
          )}
        </div>
        <div className="terminal-tabs">
          {orderedTerminals.map((t) => (
            <div
              className={`terminal-tab ${terminal === t.id ? 'active' : ''} ${t.id === 'run' ? 'pinned' : ''}`}
              key={t.id}
            >
              <button
                aria-pressed={terminal === t.id}
                className={terminal === t.id ? 'active' : ''}
                onClick={() => onSelect(t.id)}
                title={t.id === 'run' ? `Run output · ${t.alive ? 'Running' : 'Stopped'}` : t.name}
              >
                {t.id === 'run' ? (
                  <Play
                    size={13}
                    className="terminal-run-icon"
                    fill={t.alive ? 'currentColor' : 'none'}
                    aria-hidden="true"
                  />
                ) : (
                  <span className={`terminal-dot ${t.alive ? 'alive' : ''}`} />
                )}
                <span className="terminal-name">{t.name}</span>
              </button>
              {editable && !t.isRun && (
                <button
                  className="terminal-close"
                  aria-label={`Stop ${t.name}`}
                  title={`Stop ${t.name}`}
                  onClick={() => onStop(t.id)}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
    </section>
  );
}
