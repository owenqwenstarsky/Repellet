import { useState, useEffect, type ReactNode } from 'react';
import type { User } from '@repellet/shared';
import { FolderCode, Github, Settings2, LogOut, ChevronsUpDown, KeyRound } from 'lucide-react';
import { api, post, errorMessage } from './api';
import {
  UiProvider,
  useUi,
  Logo,
  Avatar,
  Spinner,
  Modal,
  MenuButton,
  MenuItem,
  Button,
  Field,
  EmptyState,
} from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { parseRoute, pathFor, type Page } from './routes';
import { AgentSettings } from './AgentSettings';
import { Auth } from './Auth';
import { Projects } from './Projects';
import { GitHubSettings } from './GitHub';
import { Admin } from './Admin';
import { Workspace } from './Workspace';
export default function App() {
  return (
    <UiProvider>
      <Application />
    </UiProvider>
  );
}
function Application() {
  const [user, setUser] = useState<User | null>(null);
  const [setup, setSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState(() => parseRoute());
  const [agentSettings, setAgentSettings] = useState(false);
  const [password, setPassword] = useState(false);
  const [workerHealthy, setWorkerHealthy] = useState<boolean | null>(null);
  const [bootError, setBootError] = useState('');
  const ui = useUi();
  function navigate(page: Page, project = '') {
    history.pushState(null, '', pathFor(page, project));
    setCurrent({ page, project });
  }
  useEffect(() => {
    Promise.all([
      api<{ required: boolean }>('/setup/status').then((v) => setSetup(v.required)),
      api<{ user: User }>('/auth/me')
        .then((v) => setUser(v.user))
        .catch(() => {}),
    ])
      .catch((e) => setBootError(errorMessage(e)))
      .finally(() => setLoading(false));
    let disposed = false;
    const health = async () => {
      try {
        const result = await api<{ worker: boolean }>('/health', {
          signal: AbortSignal.timeout(10000),
        });
        if (!disposed) setWorkerHealthy(result.worker);
      } catch {
        if (!disposed) setWorkerHealthy(false);
      }
    };
    void health();
    const healthTimer = setInterval(health, 15000);
    const pop = () => setCurrent(parseRoute());
    const unauthorized = () => {
      setPassword(false);
      setUser(null);
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('repellet:unauthorized', unauthorized);
    return () => {
      disposed = true;
      clearInterval(healthTimer);
      window.removeEventListener('popstate', pop);
      window.removeEventListener('repellet:unauthorized', unauthorized);
    };
  }, []);
  if (loading)
    return (
      <div className="boot-screen">
        <Logo />
        <Spinner label="Connecting to your workspace…" />
      </div>
    );
  if (bootError)
    return (
      <div className="boot-screen">
        <EmptyState
          icon={<Logo />}
          title="Unable to connect"
          description={bootError}
          action={<Button onClick={() => location.reload()}>Try again</Button>}
        />
      </div>
    );
  if (!user)
    return (
      <Auth
        setup={setup}
        onAuth={(u) => {
          setUser(u);
          setSetup(false);
          navigate('projects');
        }}
      />
    );
  if (current.page === 'workspace')
    return (
      <Workspace
        key={current.project}
        id={current.project}
        user={user}
        onBack={() => navigate('projects')}
        onOpen={(id) => navigate('workspace', id)}
      />
    );
  const server =
    workerHealthy === null
      ? { label: 'Checking server…', detail: 'Checking server connection', dot: 'unknown' }
      : workerHealthy
        ? { label: 'Server connected', detail: 'Containers run on your server', dot: '' }
        : {
            label: 'Container worker unavailable',
            detail: 'Workspaces cannot start until the worker reconnects',
            dot: 'offline',
          };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          aria-label="Repellet projects"
          className="brand-button"
          onClick={() => navigate('projects')}
        >
          <Logo />
        </button>
        <nav aria-label="Main">
          <NavItem
            label="Projects"
            icon={<FolderCode size={17} />}
            active={current.page === 'projects'}
            onClick={() => navigate('projects')}
          />
          <NavItem
            label="GitHub"
            icon={<Github size={17} />}
            active={current.page === 'github'}
            onClick={() => navigate('github')}
          />
          {user.isOwner && (
            <NavItem
              label="Administration"
              icon={<Settings2 size={17} />}
              active={current.page === 'admin'}
              onClick={() => navigate('admin')}
            />
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="server-status" role="status" title={server.detail}>
            <span className={`online-dot ${server.dot}`} aria-hidden="true" />
            <span>{server.label}</span>
          </div>
          <MenuButton
            label={`Account for ${user.displayName}`}
            className="account-wrap"
            menuClassName="account-menu"
            trigger={
              <>
                <Avatar name={user.displayName} size={30} />
                <span className="account-text">
                  <strong className="truncate" title={user.displayName}>
                    {user.displayName}
                  </strong>
                  <small>{user.isOwner ? 'Site owner' : 'Member'}</small>
                </span>
                <ChevronsUpDown size={14} className="account-chevron" />
              </>
            }
          >
            <MenuItem icon={<Settings2 size={15} />} onSelect={() => setAgentSettings(true)}>
              Agent settings
            </MenuItem>
            <MenuItem icon={<KeyRound size={15} />} onSelect={() => setPassword(true)}>
              Change password
            </MenuItem>
            <MenuItem
              icon={<LogOut size={15} />}
              onSelect={async () => {
                try {
                  await post('/auth/logout');
                  setUser(null);
                } catch (e) {
                  ui.notify(errorMessage(e));
                }
              }}
            >
              Sign out
            </MenuItem>
          </MenuButton>
        </div>
      </aside>
      <section className="app-content">
        {current.page === 'github' ? (
          <GitHubSettings user={user} />
        ) : current.page === 'admin' && user.isOwner ? (
          <Admin onOpen={(id) => navigate('workspace', id)} />
        ) : (
          <Projects user={user} onOpen={(id) => navigate('workspace', id)} />
        )}
      </section>
      {agentSettings && <AgentSettings onClose={() => setAgentSettings(false)} />}
      {password && <ChangePassword onClose={() => setPassword(false)} onChanged={setUser} />}
    </div>
  );
}
function NavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={active ? 'active' : ''}
      title={label}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
function ChangePassword({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: (user: User) => void;
}) {
  const { busy, run, alive, dispose } = useAsyncAction();
  const ui = useUi();
  const dismiss = () => {
    dispose();
    onClose();
  };
  return (
    <Modal title="Change password" onClose={dismiss} small>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const values = Object.fromEntries(new FormData(e.currentTarget));
          void run(async () => {
            const result = await post<{ user: User }>('/auth/password', values);
            onChanged(result.user);
            if (alive.current) dismiss();
            ui.notify('Password changed. Other sessions were signed out.', 'success');
          });
        }}
      >
        <Field label="Current password">
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            required
            data-autofocus
            disabled={busy}
          />
        </Field>
        <Field label="New password" help="At least 12 characters.">
          <input
            type="password"
            name="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            disabled={busy}
          />
        </Field>
        <div className="modal-actions">
          <Button onClick={dismiss}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Modal>
  );
}
