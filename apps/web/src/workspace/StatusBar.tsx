import type { Project } from '@repellet/shared';
import { formatBytes } from '../api';
const runtimeName = (r: string) =>
  r === 'node' ? 'Node.js' : r.charAt(0).toUpperCase() + r.slice(1);
export function StatusBar({
  project,
  connected,
  status,
  languageStatus,
}: {
  project: Project;
  connected: boolean;
  status: string;
  languageStatus: string;
}) {
  return (
    <footer className="workspace-status">
      <span className="status-left">
        <span
          className={`online-dot ${connected ? '' : 'offline'}`}
          title={connected ? 'Live updates connected' : 'Connecting to live updates'}
        />
        <span>{connected ? 'Live' : 'Connecting…'}</span>
        {status && <span className="truncate">{status}</span>}
        {languageStatus && (
          <span className="language-status truncate" title={languageStatus}>
            {languageStatus}
          </span>
        )}
      </span>
      <span className="status-right">
        <span>{project.runtimes.map(runtimeName).join(' + ')}</span>
        <span title="Workspace storage">{formatBytes(project.storageBytes)}</span>
      </span>
    </footer>
  );
}
