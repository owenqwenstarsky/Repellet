import { useEffect, useState, useRef, lazy, Suspense } from 'react';
import type { GitStatus } from '@repellet/shared';
import {
  GitBranch,
  GitBranchPlus,
  Plus,
  Minus,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  Check,
  FileDiff,
} from 'lucide-react';
import { api, post, errorMessage } from './api';
import { useUi, Spinner, Modal, LoadError, PaneHeader, IconButton, Button, EmptyState } from './ui';
const otherBranch = '\u0000other';
import { gitGroups, isConflicted } from './gitState';
const CodeDiff = lazy(() => import('./CodeDiff').then((m) => ({ default: m.CodeDiff })));
export function GitPane({
  projectId,
  editable,
  revision,
  visible = true,
}: {
  projectId: string;
  editable: boolean;
  revision: number;
  visible?: boolean;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{
    path: string;
    content: string;
    original: string;
    modified: string;
    staged: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const request = useRef(0);
  const diffRequest = useRef(0);
  useEffect(
    () => () => {
      request.current++;
      diffRequest.current++;
    },
    [projectId],
  );
  const ui = useUi();
  async function load() {
    const intent = ++request.current;
    try {
      const result = await api<GitStatus>(`/projects/${projectId}/git/status`);
      if (intent === request.current) {
        setStatus(result);
        setError('');
      }
    } catch (e) {
      if (intent === request.current) setError(errorMessage(e));
    }
  }
  useEffect(() => {
    if (visible) void load();
    return () => {
      request.current++;
    };
  }, [projectId, revision, visible]);
  async function action(action: string, extra: Record<string, unknown> = {}) {
    if (pending.current) return;
    pending.current = true;
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
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="git-pane">
      <PaneHeader
        title="Source control"
        actions={
          <>
            {editable && status?.initialized && (
              <IconButton
                size="sm"
                label="Create branch"
                icon={<GitBranchPlus size={14} />}
                disabled={busy}
                onClick={async () => {
                  const name = await ui.ask({
                    title: 'Create branch',
                    label: 'Branch name',
                    maxLength: 250,
                  });
                  if (name) void action('branch', { branch: name });
                }}
              />
            )}
            <IconButton
              size="sm"
              label="Refresh Git status"
              icon={<RefreshCw size={13} />}
              onClick={load}
            />
          </>
        }
      />
      {error && <LoadError message={error} onRetry={load} />}
      {!status ? (
        error ? null : (
          <Spinner />
        )
      ) : !status.initialized ? (
        <EmptyState
          className="pane-empty"
          icon={<GitBranch size={26} />}
          title="Not a Git repository"
          description="Initialize one to track changes, commit and push."
          action={
            editable && (
              <Button disabled={busy} onClick={() => action('init')}>
                Initialize repository
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="git-branch">
            <GitBranch size={15} />
            {editable ? (
              <select
                aria-label="Current branch"
                value={status.branch}
                disabled={busy}
                onChange={async (e) => {
                  if (e.target.value !== otherBranch) {
                    void action('checkout', { branch: e.target.value });
                    return;
                  }
                  const name = await ui.ask({
                    title: 'Switch branch',
                    label: 'Branch name',
                    maxLength: 250,
                    description: 'Enter the name of an existing local or remote branch.',
                  });
                  if (name) void action('checkout', { branch: name });
                }}
              >
                {!status.branches.includes(status.branch) && <option>{status.branch}</option>}
                {status.branches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
                <option value={otherBranch}>Switch to another branch…</option>
              </select>
            ) : (
              <strong className="truncate">{status.branch}</strong>
            )}
          </div>
          <p className="git-upstream truncate" title={status.upstream || undefined}>
            {status.upstream
              ? `Tracking ${status.upstream}`
              : 'No upstream yet. Push to create one.'}
          </p>
          {editable && (
            <>
              <div className="git-controls">
                <Button
                  size="sm"
                  disabled={busy}
                  icon={<ArrowDown size={13} />}
                  onClick={() => action('pull')}
                >
                  Pull
                  {status.behind > 0 && <span className="badge">{status.behind}</span>}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  icon={<ArrowUp size={13} />}
                  onClick={() => action('push')}
                >
                  Push
                  {status.ahead > 0 && <span className="badge">{status.ahead}</span>}
                </Button>
              </div>
              <textarea
                maxLength={10000}
                aria-label="Commit message"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Commit message…"
              />
              <Button
                variant="primary"
                size="sm"
                className="commit-button"
                icon={<Check size={14} />}
                disabled={
                  busy ||
                  !message.trim() ||
                  status.entries.some(isConflicted) ||
                  !gitGroups(status.entries)[1]!.entries.length
                }
                onClick={() => action('commit', { message })}
              >
                Commit staged changes
              </Button>
            </>
          )}
          {status.entries.some(isConflicted) && (
            <p className="form-error git-conflict" role="alert">
              Resolve and stage conflicts before committing.
            </p>
          )}
          {gitGroups(status.entries)
            .filter((group) => group.entries.length)
            .map((group) => (
              <section key={group.title}>
                <div className="git-changes-heading">
                  <span>{group.title}</span>
                  <span>{group.entries.length}</span>
                  {editable && !group.staged && (
                    <button
                      className="icon-button"
                      disabled={busy}
                      title="Stage all"
                      aria-label={`Stage all ${group.title.toLowerCase()} changes`}
                      onClick={() => action('stage', { paths: group.entries.map((e) => e.path) })}
                    >
                      <Plus size={15} />
                    </button>
                  )}
                </div>
                {group.entries.map((entry) => (
                  <div className="git-file" key={entry.path}>
                    <button
                      title={`View ${group.staged ? 'staged' : group.conflict ? 'conflicted' : 'unstaged'} diff: ${entry.path}`}
                      onClick={async () => {
                        const version = ++diffRequest.current;
                        try {
                          const result = await api<{
                            diff: string;
                            original: string;
                            modified: string;
                          }>(
                            `/projects/${projectId}/git/diff?path=${encodeURIComponent(entry.path)}&staged=${group.staged}`,
                          );
                          if (version !== diffRequest.current) return;
                          setDiff({
                            original: result.original,
                            modified: result.modified,
                            staged: group.staged,
                            path: `${group.staged ? 'Staged' : group.conflict ? 'Conflict' : 'Unstaged'}: ${entry.path}`,
                            content:
                              result.diff ||
                              'No tracked diff available. Open the file to inspect its contents.',
                          });
                        } catch (e) {
                          if (version === diffRequest.current) setError(errorMessage(e));
                        }
                      }}
                    >
                      <FileDiff size={14} />
                      <span title={entry.path}>{entry.path}</span>
                      <small>
                        {group.conflict
                          ? entry.index + entry.worktree
                          : group.staged
                            ? entry.index
                            : entry.worktree === '?'
                              ? 'U'
                              : entry.worktree}
                      </small>
                    </button>
                    {editable && (
                      <button
                        className="icon-button"
                        disabled={busy}
                        aria-label={`${group.staged ? 'Unstage' : 'Stage'} ${entry.path}`}
                        onClick={() =>
                          action(group.staged ? 'unstage' : 'stage', { paths: [entry.path] })
                        }
                      >
                        {group.staged ? <Minus size={15} /> : <Plus size={15} />}
                      </button>
                    )}
                  </div>
                ))}
              </section>
            ))}
          {!status.entries.length && <p className="pane-empty-text">Working tree is clean.</p>}
          <details className="git-help">
            <summary>How Git works here</summary>
            <p>
              Pull requires a fast-forward; resolve diverged branches and conflicts in the terminal.
              Connect a matching GitHub remote under Project settings → General to push with your
              GitHub account. Other remotes use terminal credentials. Merge, rebase and force push
              stay terminal workflows.
            </p>
          </details>
        </>
      )}
      {diff && (
        <Modal
          wide
          title={diff.path}
          onClose={() => {
            diffRequest.current++;
            setDiff(null);
          }}
        >
          {typeof diff.original === 'string' && typeof diff.modified === 'string' ? (
            <Suspense fallback={<Spinner />}>
              <CodeDiff original={diff.original} modified={diff.modified} />
            </Suspense>
          ) : (
            <pre className="diff-view">{diff.content}</pre>
          )}
        </Modal>
      )}
    </div>
  );
}
