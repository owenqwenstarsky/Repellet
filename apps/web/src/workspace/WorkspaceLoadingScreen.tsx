import { ArrowLeft } from 'lucide-react';
import { Button, Logo, Spinner } from '../ui';

export function WorkspaceLoadingScreen({
  name,
  status,
  error,
  slow,
  buildLog,
  logError,
  onBack,
  onRetry,
}: {
  name?: string;
  status: string;
  error?: string;
  slow: boolean;
  buildLog: string;
  logError: string;
  onBack: () => void;
  onRetry: () => void;
}) {
  return (
    <main className="workspace-loading-screen" aria-label="Opening project">
      <div className="workspace-loading-content">
        <Logo compact />
        <h1>{error ? 'Workspace unavailable' : name || 'Opening project'}</h1>
        {name && error && <p className="muted">{name}</p>}
        {error ? (
          <p role="alert" className="workspace-loading-error">
            {error}
          </p>
        ) : (
          <div role="status" aria-live="polite" aria-atomic="true">
            <Spinner label={status} />
          </div>
        )}
        {slow && !error && (
          <p className="muted" role="status">
            This is taking longer than usual. We’re still loading your workspace.
          </p>
        )}
        <div className="page-actions">
          <Button icon={<ArrowLeft size={15} />} onClick={onBack}>
            Back to projects
          </Button>
          {(error || slow) && (
            <Button variant="primary" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
        {logError && (
          <p role="alert" className="muted">
            Build log unavailable: {logError}
          </p>
        )}
        {buildLog && (
          <details open={!!error}>
            <summary>Environment build log</summary>
            <pre className="log">{buildLog}</pre>
          </details>
        )}
      </div>
    </main>
  );
}
