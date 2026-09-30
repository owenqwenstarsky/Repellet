import { useEffect, useState, useRef } from 'react';
import type { GitHubRepository, User } from '@repellet/shared';
import { api, post, put, remove, errorMessage } from './api';
import { useUi, Spinner } from './ui';
export function GitHubPicker({
  value,
  onSelect,
}: {
  value: GitHubRepository | null;
  onSelect: (repo: GitHubRepository | null) => void;
}) {
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    api<GitHubRepository[]>('/github/repositories')
      .then((v) => {
        if (!disposed) {
          setRepositories(v);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!disposed) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [attempt]);
  return (
    <div>
      <label>
        Filter repositories
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {loading && <Spinner label="Loading repositories…" />}
      {!loading && !error && !repositories.length && <p>No repositories available.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <a href="/github" target="_blank" rel="noreferrer">
            GitHub connection
          </a>
          <button type="button" className="text-button" onClick={() => setAttempt((v) => v + 1)}>
            Retry repositories
          </button>
        </p>
      )}
      <label>
        GitHub repository
        <select
          value={value?.id ?? ''}
          disabled={loading || !!error}
          onChange={(e) =>
            onSelect(repositories.find((r) => r.id === Number(e.target.value)) || null)
          }
        >
          <option value="">Select a repository…</option>
          {(value && !repositories.some((r) => r.id === value.id)
            ? [...repositories, value]
            : repositories
          )
            .filter(
              (r) => r.id === value?.id || r.fullName.toLowerCase().includes(query.toLowerCase()),
            )
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
                {r.canPush ? '' : ' (read only)'}
              </option>
            ))}
        </select>
      </label>
      {!loading &&
        !error &&
        !!repositories.length &&
        !repositories.some((r) => r.fullName.toLowerCase().includes(query.toLowerCase())) && (
          <p>No matching repositories.</p>
        )}
    </div>
  );
}
export function GitHubSettings({ user }: { user: User }) {
  const ui = useUi();
  const [connection, setConnection] = useState<{
    configured: boolean;
    connected: boolean;
    slug: string;
    login?: string;
    installationId?: number;
  }>();
  const [installations, setInstallations] = useState<{ id: number; account: string }[]>([]);
  const [configured, setConfigured] = useState(false),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const value = await api<typeof connection>('/github/connection');
      setConnection(value);
      if (value?.connected) setInstallations(await api('/github/installations'));
      if (user.isOwner) setConfigured((await api('/github/config')).configured);
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const inFlight = useRef(false);
  async function act(fn: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="github-settings">
      <h1>GitHub integration</h1>
      <p>
        Connect your account to import and sync repositories accessible to you and this
        installation’s GitHub App.
      </p>
      {connection?.configured ? (
        <>
          <p>
            {connection.connected
              ? `Connected as ${connection.login}`
              : 'Your GitHub account is disconnected.'}
          </p>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              act(async () => {
                location.assign((await post('/github/authorize')).url);
              })
            }
          >
            {connection.connected ? 'Reconnect GitHub' : 'Connect GitHub'}
          </button>
          {connection.connected && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await remove('/github/connection');
                  setInstallations([]);
                  await load();
                })
              }
            >
              Disconnect
            </button>
          )}
          <p>
            <a
              href={`https://github.com/apps/${connection.slug}/installations/new`}
              target="_blank"
              rel="noreferrer"
            >
              Install this app on a personal account or organization
            </a>
          </p>
          {connection.connected && (
            <label>
              App installation
              <select
                aria-label="App installation"
                disabled={busy}
                value={connection.installationId || ''}
                onChange={(e) =>
                  act(async () => {
                    await put('/github/installation', { installationId: Number(e.target.value) });
                    await load();
                  })
                }
              >
                <option value="">Select installation…</option>
                {installations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.account}
                  </option>
                ))}
              </select>
            </label>
          )}
          {connection.connected && (
            <button className="button secondary" disabled={busy} onClick={load}>
              Refresh installations
            </button>
          )}
        </>
      ) : (
        <p>The instance owner needs to configure a GitHub App.</p>
      )}
      {user.isOwner && (
        <>
          <hr />
          <h2>Instance GitHub App</h2>
          <p>
            {configured
              ? 'An app is configured. Replacing it disconnects member accounts.'
              : 'Register one app for all invited members.'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void act(async () => {
                const result = await post('/github/manifest', values);
                const form = document.createElement('form');
                form.method = 'POST';
                form.action = result.action;
                const field = document.createElement('input');
                field.type = 'hidden';
                field.name = 'manifest';
                field.value = JSON.stringify(result.manifest);
                form.append(field);
                document.body.append(form);
                form.submit();
              });
            }}
          >
            <label>
              App name
              <input name="name" defaultValue="Repellet private IDE" required maxLength={80} />
            </label>
            <label>
              Organization (optional)
              <input
                name="organization"
                placeholder="Leave empty for your personal account"
                pattern="[a-zA-Z0-9-]*"
              />
            </label>
            <button className="button primary" disabled={busy}>
              Register with GitHub manifest
            </button>
          </form>
          <details>
            <summary>Manual configuration</summary>
            <p>
              Create a public GitHub App with Contents read/write and Metadata read only. Set the
              user authorization callback to{' '}
              <code>{location.origin}/api/github/callback/authorize</code>. Webhooks can be
              disabled. Enable expiring user tokens.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const values = Object.fromEntries(new FormData(e.currentTarget));
                void act(async () => {
                  await put('/github/config', { ...values, appId: Number(values.appId) });
                  await load();
                  ui.notify('GitHub App configured.', 'success');
                });
              }}
            >
              <label>
                App ID
                <input name="appId" type="number" required min={1} />
              </label>
              <label>
                App slug
                <input name="slug" required />
              </label>
              <label>
                Client ID
                <input name="clientId" required />
              </label>
              <label>
                Client secret
                <input name="clientSecret" type="password" autoComplete="off" required />
              </label>
              <label>
                Private key (PEM)
                <textarea name="privateKey" autoComplete="off" required />
              </label>
              <button className="button primary" disabled={busy}>
                Save GitHub App
              </button>
            </form>
          </details>
        </>
      )}
    </main>
  );
}
