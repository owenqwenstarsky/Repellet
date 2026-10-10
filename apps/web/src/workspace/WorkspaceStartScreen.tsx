import { Box, Play } from 'lucide-react';
import type { Project } from '@repellet/shared';
import { Button, Spinner, LoadError } from '../ui';
export function WorkspaceStartScreen({
  project,
  buildLog,
  logError,
  onStart,
  onRetryLog,
  opening = false,
}: {
  project: Project;
  buildLog: string;
  logError: string;
  onStart: () => void;
  onRetryLog: () => void;
  opening?: boolean;
}) {
  const transitioning = opening || ['building', 'starting', 'stopping'].includes(project.state);
  return (
    <div className="workspace-preparing">
      <Box size={36} strokeWidth={1.5} />
      <h2>
        {project.state === 'failed'
          ? 'The workspace needs attention'
          : project.state === 'stopped'
            ? 'Workspace is stopped'
            : 'Preparing your environment'}
      </h2>
      <p className="muted">
        {project.error || `${project.runtimes.join(' + ')} · Your files stay on your server`}
      </p>
      {transitioning ? (
        <Spinner
          label={
            project.state === 'building'
              ? 'Installing and checking your tools…'
              : 'Updating workspace…'
          }
        />
      ) : (
        <Button variant="primary" icon={<Play size={14} />} onClick={onStart}>
          Start workspace
        </Button>
      )}
      {logError && (
        <LoadError message={`Build log unavailable: ${logError}`} onRetry={onRetryLog} />
      )}
      {buildLog && (
        <details open={project.state === 'failed'}>
          <summary>Environment build log</summary>
          <pre className="log">{buildLog}</pre>
        </details>
      )}
    </div>
  );
}
