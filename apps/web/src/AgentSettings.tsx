import { useEffect, useState } from 'react';
import type { AgentSettings as Settings } from '@repellet/shared';
import type { GetAccountResponse, LoginAccountResponse } from '@repellet/codex-protocol';
import { api, put, post, errorMessage } from './api';
import { Modal, Field, Button, Tabs, Banner, Spinner } from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { copyText } from './clipboard';
type AccountState = GetAccountResponse & {
  login: { login: LoginAccountResponse | null; state: string; error: string | null } | null;
};
export function AgentSettings({ onClose, onSaved }: { onClose: () => void; onSaved?: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const { busy, run, alive } = useAsyncAction();
  async function load() {
    try {
      const settings = await api<Settings>('/agent/settings');
      if (alive.current) setSettings(settings);
      const account = await api<AccountState>('/agent/account');
      if (alive.current) setAccount(account);
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
            setAccount(value);
            if (value.login?.state === 'completed') onSaved?.();
          }
        })
        .catch((e) => {
          if (alive.current) setError(errorMessage(e));
        });
    }, 2000);
    return () => clearInterval(timer);
  }, [account?.login?.state]);
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
          <Tabs
            label="Agent provider"
            value={settings.mode}
            onChange={(mode) => setSettings({ ...settings, mode })}
            items={[
              { id: 'chatgpt', label: 'Sign in with ChatGPT' },
              { id: 'custom', label: 'Custom API' },
            ]}
            disabled={busy}
          />
          {settings.mode === 'chatgpt' ? (
            <section className="agent-account">
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
                        await load();
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
                      await load();
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
                      await load();
                      onSaved?.();
                    })
                  }
                >
                  Disconnect ChatGPT
                </Button>
              )}
            </section>
          ) : (
            <>
              <p>
                The endpoint must support the Responses API. Keep the API path in the base URL, for
                example https://api.example.com/v1.
              </p>
              <Field label="Base URL">
                <input
                  aria-label="Base URL"
                  value={settings.baseUrl}
                  onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
                  disabled={busy}
                  type="url"
                />
              </Field>
              <Field
                label="API key"
                help={
                  settings.hasApiKey
                    ? 'A key is saved. Leave blank to retain it.'
                    : 'The key is stored in plaintext in private worker storage.'
                }
              >
                <input
                  aria-label="API key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setRemoveKey(false);
                  }}
                  disabled={busy}
                />
              </Field>
              {settings.hasApiKey && (
                <label>
                  <input
                    type="checkbox"
                    checked={removeKey}
                    onChange={(e) => {
                      setRemoveKey(e.target.checked);
                      setKey('');
                    }}
                  />{' '}
                  Remove saved key
                </label>
              )}
              <Field label="Model ID">
                <input
                  aria-label="Model ID"
                  value={settings.model}
                  onChange={(e) => setSettings({ ...settings, model: e.target.value })}
                  disabled={busy}
                />
              </Field>
              <Field label="Reasoning effort">
                <select
                  aria-label="Reasoning effort"
                  value={settings.effort || ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      effort: (e.target.value || null) as Settings['effort'],
                    })
                  }
                  disabled={busy}
                >
                  <option value="">Provider default</option>
                  {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(
                    (value) => (
                      <option key={value}>{value}</option>
                    ),
                  )}
                </select>
              </Field>
            </>
          )}
          <div className="modal-actions">
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={() =>
                action(async () => {
                  const { hasApiKey: _hasApiKey, ...fields } = settings;
                  const value = await put<Settings>('/agent/settings', {
                    ...fields,
                    ...(removeKey ? { apiKey: null } : key ? { apiKey: key } : {}),
                  });
                  if (alive.current) {
                    setSettings(value);
                    setKey('');
                    setRemoveKey(false);
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
