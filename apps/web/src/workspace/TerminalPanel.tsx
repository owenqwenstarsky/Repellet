import { Plus, X } from 'lucide-react';
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
  return (
    <section className="terminal-panel">
      <div className="terminal-toolbar">
        <div className="terminal-tabs">
          {terminals.map((t) => (
            <div className={`terminal-tab ${terminal === t.id ? 'active' : ''}`} key={t.id}>
              <button
                aria-pressed={terminal === t.id}
                className={terminal === t.id ? 'active' : ''}
                onClick={() => onSelect(t.id)}
                title={t.name}
              >
                <span className={`terminal-dot ${t.alive ? 'alive' : ''}`} />
                {t.name}
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
        {editable && (
          <IconButton size="sm" label="New terminal" icon={<Plus size={14} />} onClick={onCreate} />
        )}
      </div>
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
    </section>
  );
}
