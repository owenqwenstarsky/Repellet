import type { Project } from '@repellet/shared';
import { Banner, Button, LoadError } from '../ui';
const preparationText: Record<string, string> = {
  pending: 'Preparing files',
  files: 'Preparing files',
  installing: 'Installing dependencies',
  ready: 'Ready to run',
  failed: 'Preparation failed',
  interrupted: 'Preparation interrupted',
};
export function WorkspaceBanners({
  project,
  loadError,
  preparationLog,
  editable,
  onRetryLoad,
  onRetryPreparation,
}: {
  project: Project;
  loadError: string;
  preparationLog: string;
  editable: boolean;
  onRetryLoad: () => void;
  onRetryPreparation: () => void;
}) {
  const status = project.preparation.status;
  const failed = ['failed', 'interrupted'].includes(status);
  return (
    <div className="workspace-banners">
      {loadError && (
        <LoadError message={`Workspace update failed: ${loadError}`} onRetry={onRetryLoad} />
      )}
      {project.storageExceeded && (
        <Banner tone="warning" compact>
          Storage limit reached. Execution is suspended. Delete files to free space or ask the site
          owner to increase the limit.
        </Banner>
      )}
      {project.state === 'running' && status !== 'none' && (
        <Banner
          tone={failed ? 'danger' : status === 'ready' ? 'success' : 'info'}
          compact
          role="status"
          title={preparationText[status]}
          actions={
            editable &&
            failed && (
              <Button size="sm" onClick={onRetryPreparation}>
                Retry preparation
              </Button>
            )
          }
        >
          {project.preparation.error && <span>{project.preparation.error}</span>}
          {preparationLog && (
            <details>
              <summary>Preparation log</summary>
              <pre className="log">{preparationLog}</pre>
            </details>
          )}
        </Banner>
      )}
    </div>
  );
}
