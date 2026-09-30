import { useEffect, useState, useRef } from 'react';
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
import { useUi, Spinner, Modal, LoadError } from './ui';
import { gitGroups, isConflicted } from './gitState';
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
  const [diff, setDiff] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const request = useRef(0);
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
    try {
      const result = await post(`/projects/${projectId}/git`, { action, ...extra });
      if (result.output) ui.notify(result.output.slice(0, 500), 'success');
      await load();
      if (action === 'commit') setMessage('');
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      pending.current = false;
      setBusy(false);
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
      {error && <LoadError message={error} onRetry={load} />}
      {!status ? (
        error ? null : (
          <Spinner />
        )
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
            <strong title={status.branch}>{status.branch}</strong>
            {editable && (
              <button
                className="icon-button"
                title="Switch or create branch"
                disabled={busy}
                aria-label="Manage branches"
                onClick={async () => {
                  const name = await ui.ask({
                    title: 'Switch branch',
                    label: 'Branch name',
                    maxLength: 250,
                    description:
                      'Enter an existing branch name. To create one, use the + button below.',
                  });
                  if (name) void action('checkout', { branch: name });
                }}
              >
                <RefreshCw size={14} />
              </button>
            )}
          </div>
          {editable && (
            <>
              <div className="git-controls">
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => action('pull')}
                >
                  <ArrowDown size={14} />
                  Pull
                </button>
                <button
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => action('push')}
                >
                  <ArrowUp size={14} />
                  Push
                </button>
                <button
                  className="icon-button"
                  disabled={busy}
                  aria-label="Create branch"
                  onClick={async () => {
                    const name = await ui.ask({
                      title: 'Create branch',
                      label: 'Branch name',
                      maxLength: 250,
                    });
                    if (name) void action('branch', { branch: name });
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>
              <textarea
                maxLength={10000}
                aria-label="Commit message"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Commit message…"
              />
              <button
                className="button primary commit-button"
                disabled={
                  busy ||
                  !message.trim() ||
                  status.entries.some(isConflicted) ||
                  !gitGroups(status.entries)[1]!.entries.length
                }
                onClick={() => action('commit', { message })}
              >
                <Check size={15} />
                Commit staged changes
              </button>
            </>
          )}
          {status.entries.some(isConflicted) && (
            <p className="form-error" role="alert">
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
                        try {
                          const result = await api<{ diff: string }>(
                            `/projects/${projectId}/git/diff?path=${encodeURIComponent(entry.path)}&staged=${group.staged}`,
                          );
                          setDiff({
                            path: `${group.staged ? 'Staged' : group.conflict ? 'Conflict' : 'Unstaged'}: ${entry.path}`,
                            content:
                              result.diff ||
                              'No tracked diff available. Open the file to inspect its contents.',
                          });
                        } catch (e) {
                          ui.notify(errorMessage(e));
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
          <p className="field-help git-help">
            Configure SSH keys or Git credentials in the terminal for private remotes.
          </p>
        </>
      )}
      {diff && (
        <Modal title={diff.path} onClose={() => setDiff(null)}>
          <pre className="diff-view">{diff.content}</pre>
        </Modal>
      )}
    </div>
  );
}
