import { useEffect, useState } from 'react';
import type { GitHubRepository, User } from '@repellet/shared';
import { Github, ExternalLink, RefreshCw, Search } from 'lucide-react';
import { api, post, put, remove, errorMessage } from './api';
import {
  useUi,
  Spinner,
  Button,
  Field,
  FormRow,
  PageHeader,
  Section,
  Banner,
  EmptyState,
  LoadError,
} from './ui';
import { useAsyncAction } from './components/useAsyncAction';
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
  const matches = (r: GitHubRepository) => r.fullName.toLowerCase().includes(query.toLowerCase());
  const help = loading
    ? undefined
    : !repositories.length
      ? 'No repositories available.'
      : !repositories.some(matches)
        ? 'No matching repositories.'
        : undefined;
  if (error)
    return (
      <Banner
        tone="danger"
        actions={
          <>
            <Button size="sm" onClick={() => setAttempt((v) => v + 1)}>
              Retry repositories
            </Button>
            <a href="/github" target="_blank" rel="noreferrer" className="button link small">
              GitHub settings
            </a>
          </>
        }
      >
        {error}
      </Banner>
    );
  return (
    <div className="repo-picker">
      <div className="search-field repo-filter">
        <Search size={14} />
        <input
          aria-label="Filter repositories"
          placeholder="Filter repositories…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {loading ? (
        <Spinner label="Loading repositories…" />
      ) : (
        <Field label="GitHub repository" help={help}>
          <select
            value={value?.id ?? ''}
            onChange={(e) =>
              onSelect(repositories.find((r) => r.id === Number(e.target.value)) || null)
            }
          >
            <option value="">Select a repository…</option>
            {(value && !repositories.some((r) => r.id === value.id)
              ? [...repositories, value]
              : repositories
            )
              .filter((r) => r.id === value?.id || matches(r))
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                  {r.canPush ? '' : ' (read only)'}
                </option>
              ))}
          </select>
        </Field>
      )}
    </div>
  );
}
type Connection = {
  configured: boolean;
  connected: boolean;
  slug: string;
  login?: string;
  installationId?: number;
};
export function GitHubSettings({ user }: { user: User }) {
  const ui = useUi();
  const [connection, setConnection] = useState<Connection>();
  const [installations, setInstallations] = useState<{ id: number; account: string }[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loadError, setLoadError] = useState('');
  const { busy, run } = useAsyncAction();
  async function load() {
    try {
      const value = await api<Connection>('/github/connection');
      setConnection(value);
      if (value?.connected) setInstallations(await api('/github/installations'));
      if (user.isOwner) setConfigured((await api('/github/config')).configured);
      setLoadError('');
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="dashboard github-settings">
      <PageHeader
        title="GitHub"
        description="Connect your account to import repositories and push and pull with your own permissions."
      />
      {loadError && <LoadError message={loadError} onRetry={load} />}
      {!connection ? (
        loadError ? null : (
          <Spinner />
        )
      ) : (
        <div className="settings-stack">
          {connection.configured ? (
            <Section
              title="Your account"
              description="Repellet uses the GitHub App installed on your account or organization."
            >
              <div className="connection-row">
                <span className="connection-icon">
                  <Github size={18} />
                </span>
                <div className="list-row-main">
                  <strong>{connection.connected ? `@${connection.login}` : 'Not connected'}</strong>
                  <small>
                    {connection.connected
                      ? 'Connected to GitHub'
                      : 'Connect to import and sync repositories.'}
                  </small>
                </div>
                <div className="list-row-actions">
                  {connection.connected && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await remove('/github/connection');
                          setInstallations([]);
                          await load();
                        })
                      }
                    >
                      Disconnect
                    </Button>
                  )}
                  <Button
                    variant={connection.connected ? 'secondary' : 'primary'}
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        location.assign((await post('/github/authorize')).url);
                      })
                    }
                  >
                    {connection.connected ? 'Reconnect GitHub' : 'Connect GitHub'}
                  </Button>
                </div>
              </div>
              {connection.connected && (
                <div className="installation-row">
                  <Field
                    label="App installation"
                    help={
                      <a
                        href={`https://github.com/apps/${connection.slug}/installations/new`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Install on another account or organization{' '}
                        <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    }
                  >
                    <select
                      disabled={busy}
                      value={connection.installationId || ''}
                      onChange={(e) =>
                        run(async () => {
                          await put('/github/installation', {
                            installationId: Number(e.target.value),
                          });
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
                  </Field>
                  <Button icon={<RefreshCw size={14} />} disabled={busy} onClick={() => run(load)}>
                    Refresh installations
                  </Button>
                </div>
              )}
            </Section>
          ) : (
            <EmptyState
              icon={<Github size={28} />}
              title="GitHub isn’t set up yet"
              description={
                user.isOwner
                  ? 'Register a GitHub App below so members can connect their accounts.'
                  : 'The site owner needs to configure a GitHub App first.'
              }
            />
          )}
          {user.isOwner && (
            <InstanceApp configured={configured} busy={busy} run={run} load={load} />
          )}
        </div>
      )}
    </main>
  );
}
function InstanceApp({
  configured,
  busy,
  run,
  load,
}: {
  configured: boolean;
  busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  load: () => Promise<void>;
}) {
  const ui = useUi();
  return (
    <Section
      title="Instance GitHub App"
      description={
        configured
          ? 'An app is configured for this server. Replacing it disconnects member accounts.'
          : 'Register one app for everyone on this server. Only site owners see this.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          void run(async () => {
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
        <FormRow columns={2}>
          <Field label="App name">
            <input name="name" defaultValue="Repellet private IDE" required maxLength={80} />
          </Field>
          <Field label="Organization" optional>
            <input
              name="organization"
              placeholder="Your personal account"
              pattern="[a-zA-Z0-9-]*"
            />
          </Field>
        </FormRow>
        <div className="form-actions start">
          <Button type="submit" variant={configured ? 'secondary' : 'primary'} disabled={busy}>
            Register with GitHub manifest
          </Button>
        </div>
      </form>
      <details className="manual-config">
        <summary>Manual configuration</summary>
        <p className="field-help">
          Create a public GitHub App with Contents read/write and Metadata read only, and enable
          expiring user tokens. Webhooks can be disabled. Set the user authorization callback to:
        </p>
        <pre className="code-block">{location.origin}/api/github/callback/authorize</pre>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const values = Object.fromEntries(new FormData(e.currentTarget));
            void run(async () => {
              await put('/github/config', { ...values, appId: Number(values.appId) });
              await load();
              ui.notify('GitHub App configured.', 'success');
            });
          }}
        >
          <FormRow columns={2}>
            <Field label="App ID">
              <input name="appId" type="number" required min={1} />
            </Field>
            <Field label="App slug">
              <input name="slug" required />
            </Field>
            <Field label="Client ID">
              <input name="clientId" required />
            </Field>
            <Field label="Client secret">
              <input name="clientSecret" type="password" autoComplete="off" required />
            </Field>
          </FormRow>
          <Field label="Private key (PEM)" className="spaced">
            <textarea name="privateKey" autoComplete="off" required className="mono-input" />
          </Field>
          <div className="form-actions start">
            <Button type="submit" variant="primary" disabled={busy}>
              Save GitHub App
            </Button>
          </div>
        </form>
      </details>
    </Section>
  );
}
