import type { Project } from '@repellet/shared';
import { Banner, LoadError } from '../ui';
export function WorkspaceBanners({
  project,
  loadError,
  onRetryLoad,
}: {
  project: Project;
  loadError: string;
  onRetryLoad: () => void;
}) {
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
    </div>
  );
}
