import { useEffect, useState } from 'react';
import type { GlobalAgentApiSettings } from '@repellet/shared';
import { api, post, put, errorMessage } from './api';
import { Banner, Button, Field, Section, Spinner, useUi } from './ui';
import { useAsyncAction } from './components/useAsyncAction';

export function AdminAgentApi() {
  const [settings, setSettings] = useState<GlobalAgentApiSettings | null>(null);
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loadedConnection, setLoadedConnection] = useState('');
  const { busy, run, alive } = useAsyncAction();
  const ui = useUi();
  const signature = (baseUrl: string, key: string, remove: boolean) =>
    JSON.stringify([baseUrl, key, remove]);
  async function load() {
    try {
      const value = await api<GlobalAgentApiSettings>('/admin/agent-api');
      if (alive.current) {
        setSettings(value);
        setError('');
        setLoadedConnection(value.fetchedAt ? signature(value.baseUrl, '', false) : '');
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const action = (operation: () => Promise<void>) =>
    run(async () => {
      setError('');
      try {
        await operation();
      } catch (e) {
        if (alive.current) setError(errorMessage(e));
      }
    });
  if (!settings)
    return (
      <>
        {error ? <Banner tone="danger">{error}</Banner> : <Spinner />}
        <Button onClick={load}>Retry</Button>
      </>
    );
  const ids = [...new Set([...settings.models, ...settings.allowedModels])].sort();
  const connectionLoaded = loadedConnection === signature(settings.baseUrl, key, removeKey);
  return (
    <form
      className="resource-form"
      onSubmit={(event) => {
        event.preventDefault();
        void action(async () => {
          const value = await put<GlobalAgentApiSettings>('/admin/agent-api', {
            enabled: settings.enabled,
            baseUrl: settings.baseUrl,
            allowedModels: settings.allowedModels,
            ...(removeKey ? { apiKey: null } : key ? { apiKey: key } : {}),
          });
          if (alive.current) {
            setSettings(value);
            setKey('');
            setRemoveKey(false);
            setLoadedConnection(value.fetchedAt ? signature(value.baseUrl, '', false) : '');
            ui.notify('Agent API settings saved.', 'success');
          }
        });
      }}
    >
      <Section
        title="Global CLIProxyAPI"
        description="When enabled, this connection replaces personal proxy configuration for everyone. ChatGPT sign-in remains available."
      >
        {error && <Banner tone="danger">{error}</Banner>}
        <label className="agent-api-toggle">
          <input
            type="checkbox"
            aria-label="Enable global CLIProxyAPI"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
          />{' '}
          Enable global CLIProxyAPI
        </label>
        <Field
          label="Responses API base URL"
          help="Include the API path, for example https://proxy.example.com/v1."
        >
          <input
            aria-label="Responses API base URL"
            type="url"
            value={settings.baseUrl}
            disabled={busy}
            onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
          />
        </Field>
        <Field
          label="API key"
          help={
            settings.hasApiKey
              ? 'A key is saved. Leave blank to retain it.'
              : 'Stored in private worker storage.'
          }
        >
          <input
            aria-label="API key"
            type="password"
            autoComplete="off"
            value={key}
            disabled={busy}
            onChange={(e) => {
              setKey(e.target.value);
              setRemoveKey(false);
            }}
          />
        </Field>
        {settings.hasApiKey && (
          <label>
            <input
              type="checkbox"
              aria-label="Remove saved key"
              checked={removeKey}
              disabled={busy || settings.enabled}
              onChange={(e) => {
                setRemoveKey(e.target.checked);
                setKey('');
              }}
            />{' '}
            Remove saved key
          </label>
        )}
        <Button
          type="button"
          disabled={busy || removeKey || !settings.baseUrl || !(key || settings.hasApiKey)}
          onClick={() =>
            action(async () => {
              const result = await post<{ models: string[]; fetchedAt: number }>(
                '/admin/agent-api/models',
                {
                  baseUrl: settings.baseUrl,
                  ...(key ? { apiKey: key } : {}),
                },
              );
              if (alive.current) {
                setSettings({ ...settings, models: result.models, fetchedAt: result.fetchedAt });
                setLoadedConnection(signature(settings.baseUrl, key, removeKey));
              }
            })
          }
        >
          {settings.fetchedAt ? 'Refresh models' : 'Load models'}
        </Button>
        <Field label="Search model IDs">
          <input
            aria-label="Search model IDs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
        <fieldset className="agent-api-models" disabled={busy || !connectionLoaded}>
          <legend>Allowed model IDs ({settings.allowedModels.length})</legend>
          {ids
            .filter((id) => id.toLowerCase().includes(search.toLowerCase()))
            .map((id) => {
              const missing = !settings.models.includes(id);
              return (
                <label key={id}>
                  <input
                    type="checkbox"
                    aria-label={id}
                    checked={settings.allowedModels.includes(id)}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        allowedModels: e.target.checked
                          ? [...settings.allowedModels, id]
                          : settings.allowedModels.filter((model) => model !== id),
                      })
                    }
                  />
                  <code>{id}</code>
                  {missing && <small>Unavailable</small>}
                </label>
              );
            })}
          {!ids.length && <p>Load models to choose which IDs users can access.</p>}
        </fieldset>
        <p>
          New models stay unchecked. If no models are selected, CLIProxyAPI cannot run agent turns.
        </p>
        {settings.enabled && !connectionLoaded && (
          <p role="status">Load models for this connection before saving.</p>
        )}
        <Button
          variant="primary"
          type="submit"
          busy={busy}
          disabled={busy || (settings.enabled && (!connectionLoaded || removeKey))}
        >
          Save agent API settings
        </Button>
      </Section>
    </form>
  );
}
