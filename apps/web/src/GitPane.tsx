import { useEffect, useState, lazy, Suspense } from 'react';
import type { GitStatus } from '@repellet/shared';
import {
  GitBranch,
  Plus,
  Minus,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Check,
  FileDiff,
} from 'lucide-react';
import { api, post, errorMessage } from './api';
import { useUi, Spinner, Modal } from './ui';
const CodeDiff = lazy(() => import('./CodeDiff').then((m) => ({ default: m.CodeDiff })));
export function GitPane({
  projectId,
  editable,
  revision,
}: {
  projectId: string;
  editable: boolean;
  revision: number;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{
      path: string;
      original: string;
      modified: string;
      staged: boolean;
    } | null>(null),
    [error, setError] = useState('');
  const ui = useUi();
  async function load() {
    try {
      setStatus(await api(`/projects/${projectId}/git/status`));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, [projectId, revision]);
  async function action(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await post(`/projects/${projectId}/git`, { action, ...extra });
      if (result.output) ui.notify(result.output.slice(0, 500), 'success');
      await load();
      if (action === 'commit') setMessage('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const staged = status?.entries.filter((e) => ![' ', '?'].includes(e.index)) || [],
    unstaged = status?.entries.filter((e) => e.worktree !== ' ') || [];
  async function showDiff(path: string, staged: boolean) {
    try {
      const result = await api<{ original: string; modified: string }>(
        `/projects/${projectId}/git/diff?path=${encodeURIComponent(path)}&staged=${staged}`,
      );
      setDiff({ path, staged, ...result });
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="git-pane">
      <div className="pane-heading">
        <span>SOURCE CONTROL</span>
        <button className="icon-button" aria-label="Refresh Git status" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      {error && (
        <div className="form-error" role="alert">
          <p>{error}</p>
          <p className="field-help">
            Pull requires a fast-forward. For diverged branches or conflicts, resolve in the
            terminal. GitHub remotes need an active connection and repository permission; protected
            branches may reject pushes.
          </p>
        </div>
      )}
      {!status ? (
        <Spinner />
      ) : !status.initialized ? (
        <div className="pane-empty">
          <GitBranch size={30} />
          <p>This project isn’t a Git repository yet.</p>
          {editable && (
            <button className="button secondary" disabled={busy} onClick={() => action('init')}>
              Initialize repository
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="git-branch">
            <GitBranch size={16} />
            {editable ? (
              <select
                aria-label="Current branch"
                value={status.branch}
                disabled={busy}
                onChange={(e) => action('checkout', { branch: e.target.value })}
              >
                {!status.branches.includes(status.branch) && <option>{status.branch}</option>}
                {status.branches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            ) : (
              <strong>{status.branch}</strong>
            )}
            {editable && (
              <button
                className="icon-button"
                aria-label="Create branch"
                onClick={async () => {
                  const name = await ui.ask({ title: 'Create branch', label: 'Branch name' });
                  if (name) void action('branch', { branch: name });
                }}
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          <p className="field-help">
            {status.upstream || 'No upstream; first push establishes it'} · ↑{status.ahead} ↓
            {status.behind}
          </p>
          {editable && (
            <>
              <div className="git-actions">
                <button className="button secondary" disabled={busy} onClick={() => action('pull')}>
                  <ArrowDown size={14} />
                  Pull
                </button>
                <button className="button secondary" disabled={busy} onClick={() => action('push')}>
                  <ArrowUp size={14} />
                  Push
                </button>
              </div>
              <div className="commit-box">
                <textarea
                  aria-label="Commit message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Commit message"
                />
                <button
                  className="button primary"
                  disabled={busy || !message.trim() || !staged.length}
                  onClick={() => action('commit', { message })}
                >
                  <Check size={14} />
                  Commit staged
                </button>
              </div>
            </>
          )}
          {(
            [
              ['Staged', staged, true],
              ['Unstaged', unstaged, false],
            ] as const
          ).map(([label, entries, staged]) => (
            <section key={label}>
              <div className="pane-heading">
                {label} ({entries.length})
              </div>
              {entries.map((e) => (
                <div className="git-file" key={e.path}>
                  <button onClick={() => showDiff(e.path, staged)}>
                    <FileDiff size={14} />
                    <span>{e.path}</span>
                    <small>{staged ? e.index : e.worktree}</small>
                  </button>
                  {editable && (
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`${staged ? 'Unstage' : 'Stage'} ${e.path}`}
                      onClick={() => action(staged ? 'unstage' : 'stage', { paths: [e.path] })}
                    >
                      {staged ? <Minus size={15} /> : <Plus size={15} />}
                    </button>
                  )}
                </div>
              ))}
            </section>
          ))}
          {!status.entries.length && <p className="pane-empty-text">Working tree is clean.</p>}
          <p className="field-help git-help">
            Use Repository setup to connect a matching GitHub remote. Other remotes use terminal
            credentials. Merge, rebase, and force push remain terminal workflows.
          </p>
        </>
      )}
      {diff && (
        <Modal
          title={`${diff.path} · ${diff.staged ? 'staged' : 'unstaged'}`}
          onClose={() => setDiff(null)}
        >
          <Suspense fallback={<Spinner />}>
            <CodeDiff original={diff.original} modified={diff.modified} />
          </Suspense>
        </Modal>
      )}
    </div>
  );
}
