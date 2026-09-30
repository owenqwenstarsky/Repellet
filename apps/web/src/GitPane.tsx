import { useEffect, useState } from 'react';
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
export function GitPane({
  projectId,
  editable,
  revision,
}: {
  projectId: string;
  editable: boolean;
  revision: number;
}) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{ path: string; content: string } | null>(null);
  const ui = useUi();
  async function load() {
    try {
      setStatus(await api(`/projects/${projectId}/git/status`));
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, [projectId, revision]);
  async function action(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    try {
      const result = await post(`/projects/${projectId}/git`, { action, ...extra });
      if (result.output) ui.notify(result.output.slice(0, 500), 'success');
      await load();
      if (action === 'commit') setMessage('');
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
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
            <strong>{status.branch}</strong>
            {editable && (
              <button
                className="icon-button"
                title="Switch or create branch"
                aria-label="Manage branches"
                onClick={async () => {
                  const name = await ui.ask({
                    title: 'Switch branch',
                    label: 'Branch name',
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
                    const name = await ui.ask({ title: 'Create branch', label: 'Branch name' });
                    if (name) void action('branch', { branch: name });
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>
              <textarea
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
                  !status.entries.some((e) => e.index !== ' ' && e.index !== '?')
                }
                onClick={() => action('commit', { message })}
              >
                <Check size={15} />
                Commit staged changes
              </button>
            </>
          )}
          <div className="git-changes-heading">
            <span>CHANGES</span>
            <span>{status.entries.length}</span>
            {editable && status.entries.length > 0 && (
              <button
                className="icon-button"
                title="Stage all"
                aria-label="Stage all changes"
                onClick={() => action('stage', { paths: status.entries.map((e) => e.path) })}
              >
                <Plus size={15} />
              </button>
            )}
          </div>
          {status.entries.length ? (
            status.entries.map((entry) => (
              <div className="git-file" key={entry.path}>
                <button
                  title="View diff"
                  onClick={async () => {
                    try {
                      const result = await api<{ diff: string }>(
                        `/projects/${projectId}/git/diff?path=${encodeURIComponent(entry.path)}&staged=${entry.index !== ' ' && entry.index !== '?'}`,
                      );
                      setDiff({
                        path: entry.path,
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
                  <span>{entry.path}</span>
                  <small>
                    {entry.index === ' ' ? 'M' : entry.index === '?' ? 'U' : entry.index}
                  </small>
                </button>
                {editable && (
                  <button
                    className="icon-button"
                    disabled={busy}
                    aria-label={`${entry.index !== ' ' && entry.index !== '?' ? 'Unstage' : 'Stage'} ${entry.path}`}
                    onClick={() =>
                      action(entry.index !== ' ' && entry.index !== '?' ? 'unstage' : 'stage', {
                        paths: [entry.path],
                      })
                    }
                  >
                    {entry.index !== ' ' && entry.index !== '?' ? (
                      <Minus size={15} />
                    ) : (
                      <Plus size={15} />
                    )}
                  </button>
                )}
              </div>
            ))
          ) : (
            <p className="pane-empty-text">Working tree is clean.</p>
          )}
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
