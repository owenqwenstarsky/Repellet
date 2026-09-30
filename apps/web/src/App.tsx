import { useState, useEffect, useRef } from 'react';
import type { User } from '@repellet/shared';
import {
  FolderCode,
  Users,
  Settings2,
  LogOut,
  ChevronDown,
  Server,
  ArrowUpRight,
  KeyRound,
} from 'lucide-react';
import { api, post, errorMessage } from './api';
import { UiProvider, useUi, Logo, Avatar, Spinner, Modal, Menu } from './ui';
import { Auth } from './Auth';
import { Projects } from './Projects';
import { Admin } from './Admin';
import { Workspace } from './Workspace';
function route() {
  const match = location.pathname.match(/^\/projects\/([a-f0-9-]+)$/);
  return match
    ? { page: 'workspace', project: match[1] }
    : { page: location.pathname === '/admin' ? 'admin' : 'projects', project: '' };
}
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
  const [current, setCurrent] = useState(route);
  const [userMenu, setUserMenu] = useState(false);
  const [password, setPassword] = useState(false);
  const [workerHealthy, setWorkerHealthy] = useState<boolean | null>(null);
  const [bootError, setBootError] = useState('');
  const ui = useUi();
  function navigate(page: string, project = '') {
    history.pushState(
      null,
      '',
      page === 'workspace' ? `/projects/${project}` : page === 'admin' ? '/admin' : '/',
    );
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
    const pop = () => setCurrent(route());
    const unauthorized = () => setUser(null);
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
        <Logo />
        <h2>Unable to connect</h2>
        <p className="muted">{bootError}</p>
        <button className="button secondary" onClick={() => location.reload()}>
          Try again
        </button>
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
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav>
          <button
            aria-label="Projects"
            aria-current={current.page === 'projects' ? 'page' : undefined}
            className={current.page === 'projects' ? 'active' : ''}
            onClick={() => navigate('projects')}
          >
            <FolderCode size={18} />
            Projects
          </button>
          {user.isOwner && (
            <button
              aria-label="Administration"
              aria-current={current.page === 'admin' ? 'page' : undefined}
              className={current.page === 'admin' ? 'active' : ''}
              onClick={() => navigate('admin')}
            >
              <Settings2 size={18} />
              Administration
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div
            className="server-status"
            role="status"
            title={
              workerHealthy === null
                ? 'Checking server connection'
                : workerHealthy
                  ? 'Server connected'
                  : 'Container worker unavailable'
            }
          >
            <Server size={15} />
            <span>
              {workerHealthy === null
                ? 'Checking server connection…'
                : workerHealthy
                  ? 'Your server is connected'
                  : 'Container worker unavailable'}
            </span>
            <span
              className={`online-dot ${workerHealthy === null ? 'unknown' : workerHealthy ? '' : 'offline'}`}
              title={
                workerHealthy === null
                  ? 'Checking server connection'
                  : workerHealthy
                    ? 'Server connected'
                    : 'Worker unavailable'
              }
            />
          </div>
          <div className="account-wrap">
            <button
              aria-label={`Account for ${user.displayName}`}
              aria-haspopup="menu"
              aria-expanded={userMenu}
              className="account-button"
              onClick={() => setUserMenu(!userMenu)}
            >
              <Avatar name={user.displayName} size={32} />
              <span>
                <strong title={user.displayName}>{user.displayName}</strong>
                <small>{user.isOwner ? 'Site owner' : 'Member'}</small>
              </span>
              <ChevronDown size={14} />
            </button>
            {userMenu && (
              <>
                <div className="menu-dismiss" onClick={() => setUserMenu(false)} />
                <Menu className="account-menu" onClose={() => setUserMenu(false)}>
                  <button
                    onClick={() => {
                      setUserMenu(false);
                      setPassword(true);
                    }}
                  >
                    <KeyRound size={15} />
                    Change password
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        await post('/auth/logout');
                        setUser(null);
                      } catch (e) {
                        ui.notify(errorMessage(e));
                      }
                      setUserMenu(false);
                    }}
                  >
                    <LogOut size={15} />
                    Sign out
                  </button>
                </Menu>
              </>
            )}
          </div>
        </div>
      </aside>
      <section className="app-content">
        <div className="app-topbar">
          <span>
            {current.page === 'admin' ? 'Administration' : 'Workspace'} <span>/</span>{' '}
            {current.page === 'admin' ? 'Overview' : 'Projects'}
          </span>
          <span className="private-label">
            <span className="online-dot" />
            Private installation
          </span>
        </div>
        {current.page === 'admin' && user.isOwner ? (
          <Admin onOpen={(id) => navigate('workspace', id)} />
        ) : (
          <Projects user={user} onOpen={(id) => navigate('workspace', id)} />
        )}
      </section>
      {password && <ChangePassword onClose={() => setPassword(false)} onChanged={setUser} />}
    </div>
  );
}

function ChangePassword({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: (user: User) => void;
}) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    pending = useRef(false);
  const ui = useUi();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const dismiss = () => {
    alive.current = false;
    onClose();
  };
  return (
    <Modal title="Change password" onClose={dismiss} small>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending.current) return;
          const values = Object.fromEntries(new FormData(e.currentTarget));
          pending.current = true;
          setBusy(true);
          try {
            const result = await post<{ user: User }>('/auth/password', values);
            onChanged(result.user);
            if (alive.current) dismiss();
            ui.notify('Password changed. Other sessions were signed out.', 'success');
          } catch (e) {
            ui.notify(errorMessage(e));
          } finally {
            pending.current = false;
            if (alive.current) setBusy(false);
          }
        }}
      >
        <label>
          Current password
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            required
            data-autofocus
            disabled={busy}
          />
        </label>
        <label>
          New password
          <input
            type="password"
            name="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            disabled={busy}
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={dismiss}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            Change password
          </button>
        </div>
      </form>
    </Modal>
  );
}
