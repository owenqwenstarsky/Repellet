import { Play, Square, Settings, RotateCw } from 'lucide-react';
import type { Project } from '@repellet/shared';
import { Logo, Avatar, Status, Button, IconButton, shortcutText } from '../ui';
export function WorkspaceHeader({
  project,
  peers,
  editable,
  canRun,
  busy,
  running,
  onBack,
  onRun,
  onStopApp,
  onSettings,
}: {
  project: Project;
  peers: { id: string; name: string }[];
  editable: boolean;
  canRun: boolean;
  busy: boolean;
  running: boolean;
  onBack: () => void;
  onRun: () => void;
  onStopApp: () => void;
  onSettings: () => void;
}) {
  const runLabel = running ? 'Restart' : 'Run';
  return (
    <header className="workspace-header">
      <button
        className="brand-button workspace-back"
        title="Back to projects"
        aria-label="Back to projects"
        onClick={onBack}
      >
        <Logo compact />
      </button>
      <div className="workspace-identity">
        <strong className="workspace-title truncate" title={project.name}>
          {project.name}
        </strong>
        <Status state={running ? 'running' : 'idle'} />
      </div>
      <div className="workspace-header-spacer" />
      {peers.length > 0 && (
        <div className="collaborators" title="People in this workspace">
          {peers.slice(0, 4).map((p) => (
            <Avatar key={p.id} name={p.name} size={24} />
          ))}
          {peers.length > 4 && <span>+{peers.length - 4}</span>}
        </div>
      )}
      {project.role === 'viewer' && <span className="role-label">View only</span>}
      <IconButton
        label="Project settings"
        title="Project settings and people"
        icon={<Settings size={16} />}
        onClick={onSettings}
      />
      {editable && (
        <div className="run-controls">
          {running && (
            <Button
              size="sm"
              aria-label="Stop app"
              title="Stop app"
              disabled={busy}
              icon={<Square size={11} fill="currentColor" />}
              onClick={onStopApp}
            >
              Stop
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            aria-label="Run"
            title={`${runLabel} (${shortcutText(['mod', 'enter'])})`}
            className="run-button"
            disabled={!canRun}
            busy={busy}
            icon={running ? <RotateCw size={13} /> : <Play size={12} fill="currentColor" />}
            onClick={onRun}
          >
            {runLabel}
          </Button>
        </div>
      )}
    </header>
  );
}
