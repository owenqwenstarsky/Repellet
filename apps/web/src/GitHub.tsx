import { useEffect, useState } from 'react';
import type { GitHubRepository, User } from '@repellet/shared';
import { api, post, put, remove, errorMessage } from './api';
import { useUi } from './ui';
export function GitHubPicker({ onSelect }: { onSelect: (repo: GitHubRepository | null) => void }) {
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]),
    [query, setQuery] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    api<GitHubRepository[]>('/github/repositories')
      .then((v) => {
        if (!disposed) setRepositories(v);
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <div>
      <label>
        Filter repositories
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {error && (
        <p className="form-error">
          {error}{' '}
          <a href="/github" target="_blank" rel="noreferrer">
            GitHub connection
          </a>
        </p>
      )}
      <label>
        GitHub repository
        <select
          defaultValue=""
          onChange={(e) =>
            onSelect(repositories.find((r) => r.id === Number(e.target.value)) || null)
          }
        >
          <option value="">Select a repository…</option>
          {repositories
            .filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase()))
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
                {r.canPush ? '' : ' (read only)'}
              </option>
            ))}
        </select>
      </label>
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
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
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
            <button className="button secondary" onClick={load}>
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
