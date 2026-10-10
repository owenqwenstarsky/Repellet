import { useEffect, useState } from 'react';
import type { AgentSettings as Settings, AgentModelCatalog } from '@repellet/shared';
import type { GetAccountResponse, LoginAccountResponse, Model } from '@repellet/agent-protocol';
import { api, put, post, errorMessage } from './api';
import { Modal, Field, Button, Banner, Spinner } from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { copyText } from './clipboard';
type AccountState = GetAccountResponse & {
  login: { login: LoginAccountResponse | null; state: string; error: string | null } | null;
};
export function AgentSettings({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedBaseUrl, setSavedBaseUrl] = useState('');
  const [account, setAccount] = useState<AccountState | null>(null);
  const [key, setKey] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [draftCatalog, setDraftCatalog] = useState<Model[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [migration, setMigration] = useState<{
    imported: number;
    skipped: number;
    errors?: string[];
    importedConversations?: string[];
    skippedConversations?: string[];
  } | null>(null);
  const { busy, run, alive } = useAsyncAction();
  function acceptAccount(value: AccountState) {
    setAccount(value);
    setSettings((current) =>
      current
        ? {
            ...current,
            availability: {
              ...current.availability,
              chatgpt: {
                available: !!value.account,
                reason: value.account ? null : 'Sign in with ChatGPT in Agent settings.',
              },
            },
          }
        : current,
    );
  }
  async function loadAccount() {
    const value = await api<AccountState>('/agent/account');
    if (alive.current) acceptAccount(value);
  }
  async function load() {
    try {
      const settings = await api<Settings>('/agent/settings');
      if (alive.current) {
        setSettings(settings);
        setSavedBaseUrl(settings.personalProxy?.baseUrl || '');
      }
      const account = await api<AccountState>('/agent/account');
      if (alive.current) acceptAccount(account);
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (account?.login?.state !== 'pending') return;
    const timer = setInterval(() => {
      void api<AccountState>('/agent/account')
        .then((value) => {
          if (alive.current) {
            acceptAccount(value);
            if (value.login?.state === 'completed') onSaved?.();
          }
        })
        .catch((e) => {
          if (alive.current) setError(errorMessage(e));
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [account?.login?.state]);
  useEffect(() => {
    if (!settings) return;
    if (settings.defaultApi === 'cliproxyapi' && draftCatalog) {
      setModels(draftCatalog);
      setCatalogLoading(false);
      setCatalogError('');
      return;
    }
    if (
      settings.defaultApi === 'cliproxyapi' &&
      settings.proxySource !== 'global' &&
      (key || removeKey || settings.personalProxy?.baseUrl !== savedBaseUrl)
    ) {
      setModels([]);
      setCatalogLoading(false);
      setCatalogError('Load models for this connection before choosing a model.');
      return;
    }
    let disposed = false;
    setModels([]);
    setCatalogError('');
    setCatalogLoading(true);
    void api<AgentModelCatalog>('/agent/models?api=' + settings.defaultApi)
      .then((value) => {
        if (!disposed) {
          setModels(value.data);
          setCatalogError(value.error || '');
        }
      })
      .catch((e) => {
        if (!disposed) setCatalogError(errorMessage(e));
      })
      .finally(() => {
        if (!disposed) setCatalogLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [
    settings?.defaultApi,
    settings?.proxySource,
    settings?.personalProxy?.baseUrl,
    savedBaseUrl,
    key,
    removeKey,
    draftCatalog,
  ]);
  function updatePreference(field: 'model' | 'effort', value: string) {
    if (!settings) return;
    const selected = settings.defaultApi;
    setSettings({
      ...settings,
      defaults: {
        ...settings.defaults,
        [selected]: {
          ...settings.defaults[selected],
          [field]: field === 'effort' ? value || null : value,
          ...(field === 'model'
            ? {
                effort:
                  models.find((model) => model.model === value)?.defaultReasoningEffort || null,
              }
            : {}),
        },
      },
    });
  }
  const action = (operation: () => Promise<void>) =>
    run(async () => {
      setError('');
      try {
        await operation();
      } catch (e) {
        if (alive.current) setError(errorMessage(e));
      }
    });
  const login = account?.login?.login;
  useEffect(() => {
    setCopied(false);
  }, [login?.type === 'chatgptDeviceCode' ? login.loginId : null]);
  return (
    <Modal title="Agent settings" onClose={onClose}>
      <p>Your agent account applies to all projects you own.</p>
      {error && <Banner tone="danger">{error}</Banner>}
      {!settings ? (
        <>
          <Spinner />
          <Button onClick={load}>Retry</Button>
        </>
      ) : (
        <>
          <section className="agent-defaults">
            <h3>Agent defaults</h3>
            <Field label="Default API">
              <select
                aria-label="Default API"
                value={settings.defaultApi}
                disabled={busy}
                onChange={(e) =>
                  setSettings({ ...settings, defaultApi: e.target.value as Settings['defaultApi'] })
                }
              >
                <option value="chatgpt">ChatGPT Auth</option>
                <option value="cliproxyapi">
                  {settings.proxySource === 'global' ? 'CLIProxyAPI' : 'Custom API'}
                </option>
              </select>
            </Field>
            {!settings.availability[settings.defaultApi].available && (
              <p role="status">{settings.availability[settings.defaultApi].reason}</p>
            )}
            <Field label="Default model">
              <select
                aria-label="Default model"
                value={settings.defaults[settings.defaultApi].model}
                disabled={busy || catalogLoading}
                onChange={(e) => updatePreference('model', e.target.value)}
              >
                <option value="">Provider default</option>
                {settings.defaults[settings.defaultApi].model &&
                  !models.some(
                    (model) => model.model === settings.defaults[settings.defaultApi].model,
                  ) && (
                    <option value={settings.defaults[settings.defaultApi].model} disabled>
                      {settings.defaults[settings.defaultApi].model} (unavailable)
                    </option>
                  )}
                {models.map((model) => (
                  <option key={model.id} value={model.model}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default reasoning effort">
              <select
                aria-label="Default reasoning effort"
                value={settings.defaults[settings.defaultApi].effort || ''}
                disabled={busy || catalogLoading}
                onChange={(e) => updatePreference('effort', e.target.value)}
              >
                <option value="">Provider default</option>
                {settings.defaults[settings.defaultApi].effort &&
                  !models
                    .find(
                      (model) =>
                        model.model ===
                        (settings.defaults[settings.defaultApi].model ||
                          models.find((item) => item.isDefault)?.model),
                    )
                    ?.supportedReasoningEfforts.some(
                      (option) =>
                        option.reasoningEffort === settings.defaults[settings.defaultApi].effort,
                    ) && (
                    <option value={settings.defaults[settings.defaultApi].effort || ''} disabled>
                      {settings.defaults[settings.defaultApi].effort} (unavailable)
                    </option>
                  )}
                {(
                  models.find(
                    (model) =>
                      model.model ===
                      (settings.defaults[settings.defaultApi].model ||
                        models.find((item) => item.isDefault)?.model),
                  )?.supportedReasoningEfforts || []
                ).map((option) => (
                  <option key={option.reasoningEffort} value={option.reasoningEffort}>
                    {option.reasoningEffort}
                  </option>
                ))}
              </select>
            </Field>
            {catalogError && <Banner tone="danger">{catalogError}</Banner>}
            <Button
              disabled={busy || catalogLoading}
              onClick={() =>
                action(async () => {
                  const value = await api<AgentModelCatalog>(
                    '/agent/models?api=' + settings.defaultApi + '&refresh=true',
                  );
                  if (alive.current) {
                    setModels(value.data);
                    setCatalogError(value.error || '');
                  }
                })
              }
            >
              Refresh models
            </Button>
          </section>
          <section className="agent-account">
            <h3>ChatGPT account</h3>
            {account?.account?.type === 'chatgpt' && (
              <p>
                Connected as <strong>{account.account.email || 'ChatGPT account'}</strong> ·{' '}
                {account.account.planType}
              </p>
            )}
            {account?.login?.state === 'pending' && login?.type === 'chatgptDeviceCode' ? (
              <>
                <p>Enter this one-time code at the verification page:</p>
                <div className="agent-device-code">
                  <code>{login.userCode}</code>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        setCopied(false);
                        await copyText(login.userCode);
                        if (alive.current) setCopied(true);
                      })
                    }
                  >
                    Copy code
                  </Button>
                </div>
                {copied && <p role="status">Code copied.</p>}
                <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">
                  Open ChatGPT verification
                </a>
                <p role="status">Waiting for sign-in…</p>
                <Button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await post('/agent/login/cancel', { loginId: login.loginId });
                      await loadAccount();
                    })
                  }
                >
                  Cancel sign-in
                </Button>
              </>
            ) : (
              <Button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await post('/agent/login');
                    await loadAccount();
                  })
                }
              >
                {account?.account ? 'Reconnect ChatGPT' : 'Sign in with ChatGPT'}
              </Button>
            )}
            {account?.login?.state === 'completed' && (
              <p role="status">ChatGPT sign-in complete.</p>
            )}
            {account?.login?.state === 'error' && <p role="alert">{account.login.error}</p>}
            {account?.login?.state === 'cancelled' && <p role="status">Sign-in cancelled.</p>}
            {account?.account && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await post('/agent/logout');
                    await loadAccount();
                    onSaved?.();
                  })
                }
              >
                Disconnect ChatGPT
              </Button>
            )}
          </section>
          {settings.proxySource === 'global' ? (
            <p role="status">CLIProxyAPI is managed by your administrator.</p>
          ) : (
            <section className="agent-personal-proxy">
              <h3>Custom API</h3>
              <p>
                The endpoint must support the Responses API. Include its API path, for example
                https://api.example.com/v1.
              </p>
              <Field label="Base URL">
                <input
                  aria-label="Base URL"
                  type="url"
                  disabled={busy}
                  value={settings.personalProxy?.baseUrl || ''}
                  onChange={(e) => {
                    setSettings({
                      ...settings,
                      personalProxy: {
                        baseUrl: e.target.value,
                        hasApiKey: settings.personalProxy?.hasApiKey || false,
                      },
                    });
                    setDraftCatalog(null);
                    if (settings.defaultApi === 'cliproxyapi') setModels([]);
                  }}
                />
              </Field>
              <Field
                label="API key"
                help={
                  settings.personalProxy?.hasApiKey
                    ? 'A key is saved. Leave blank to retain it.'
                    : 'The key is stored in private worker storage.'
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
                    setDraftCatalog(null);
                    if (settings.defaultApi === 'cliproxyapi') setModels([]);
                  }}
                />
              </Field>
              {settings.personalProxy?.hasApiKey && (
                <label>
                  <input
                    type="checkbox"
                    checked={removeKey}
                    disabled={busy}
                    onChange={(e) => {
                      setRemoveKey(e.target.checked);
                      setKey('');
                      setDraftCatalog(null);
                    }}
                  />{' '}
                  Remove saved key
                </label>
              )}
              <Button
                disabled={
                  busy ||
                  removeKey ||
                  !settings.personalProxy?.baseUrl ||
                  !(key || settings.personalProxy?.hasApiKey)
                }
                onClick={() =>
                  action(async () => {
                    const value = await post<AgentModelCatalog>('/agent/models', {
                      baseUrl: settings.personalProxy?.baseUrl || '',
                      ...(key ? { apiKey: key } : {}),
                    });
                    if (alive.current) {
                      setDraftCatalog(value.data);
                      setCatalogError(value.error || '');
                    }
                  })
                }
              >
                Load models
              </Button>
            </section>
          )}
          <section className="agent-migration">
            <p>Bring existing Codex conversations into Pi sessions.</p>
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const result = await post<{
                    imported: number;
                    skipped: number;
                    errors?: string[];
                    importedConversations?: string[];
                    skippedConversations?: string[];
                  }>('/agent/import', {});
                  if (alive.current) setMigration(result);
                })
              }
            >
              Import previous conversations
            </Button>
            {migration && (
              <div role="status">
                <p>
                  Imported {migration.imported}; skipped {migration.skipped}.
                  {!!migration.errors?.length && (
                    <span>
                      {' '}
                      {migration.errors.length} import errors. Original conversations were
                      preserved.
                    </span>
                  )}
                </p>
                {!!(
                  (migration.importedConversations?.length || 0) +
                  (migration.skippedConversations?.length || 0)
                ) && (
                  <details>
                    <summary>View import result</summary>
                    <ul>
                      {[
                        ...(migration.importedConversations || []).map((name) => ({
                          name,
                          status: 'Imported',
                        })),
                        ...(migration.skippedConversations || []).map((name) => ({
                          name,
                          status: 'Skipped',
                        })),
                      ]
                        .slice(0, 100)
                        .map((entry, index) => (
                          <li key={index}>
                            {entry.status}: {entry.name}
                          </li>
                        ))}
                    </ul>
                    {migration.imported + migration.skipped > 100 && (
                      <p>{migration.imported + migration.skipped - 100} more conversations.</p>
                    )}
                  </details>
                )}
              </div>
            )}
          </section>
          <div className="modal-actions">
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={() =>
                action(async () => {
                  const fields = {
                    version: settings.version,
                    defaultApi: settings.defaultApi,
                    defaults: settings.defaults,
                  };
                  const value = await put<Settings>('/agent/settings', {
                    ...fields,
                    ...(settings.proxySource !== 'global'
                      ? {
                          personalProxy: {
                            baseUrl: settings.personalProxy?.baseUrl || '',
                            ...(removeKey ? { apiKey: null } : key ? { apiKey: key } : {}),
                          },
                        }
                      : {}),
                  });
                  if (alive.current) {
                    setSettings(value);
                    setSavedBaseUrl(value.personalProxy?.baseUrl || '');
                    setKey('');
                    setRemoveKey(false);
                    setDraftCatalog(null);
                    onSaved?.();
                  }
                })
              }
            >
              Save agent settings
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
