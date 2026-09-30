import { useState, useEffect } from 'react';
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
import { UiProvider, useUi, Logo, Avatar, Spinner, Modal } from './ui';
import { Auth } from './Auth';
import { Projects } from './Projects';
import { GitHubSettings } from './GitHub';
import { Admin } from './Admin';
import { Workspace } from './Workspace';
function route() {
  const match = location.pathname.match(/^\/projects\/([a-f0-9-]+)$/);
  return match
    ? { page: 'workspace', project: match[1] }
    : {
        page:
          location.pathname === '/admin'
            ? 'admin'
            : location.pathname === '/github'
              ? 'github'
              : 'projects',
        project: '',
      };
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
  const [workerHealthy, setWorkerHealthy] = useState(true);
  const [bootError, setBootError] = useState('');
  const ui = useUi();
  function navigate(page: string, project = '') {
    history.pushState(
      null,
      '',
      page === 'workspace'
        ? `/projects/${project}`
        : page === 'admin'
          ? '/admin'
          : page === 'github'
            ? '/github'
            : '/',
    );
    setCurrent({ page, project });
  }
  useEffect(() => {
    Promise.all([
      api<{ required: boolean }>('/setup/status').then((v) => setSetup(v.required)),
      api<{ user: User }>('/auth/me')
        .then((v) => setUser(v.user))
        .catch(() => {}),
      api<{ worker: boolean }>('/health').then((v) => setWorkerHealthy(v.worker)),
    ])
      .catch((e) => setBootError(errorMessage(e)))
      .finally(() => setLoading(false));
    const pop = () => setCurrent(route());
    const unauthorized = () => setUser(null);
    window.addEventListener('popstate', pop);
    window.addEventListener('repellet:unauthorized', unauthorized);
    return () => {
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
        <button className="brand-button" onClick={() => navigate('projects')}>
          <Logo />
        </button>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav>
          <button
            className={current.page === 'projects' ? 'active' : ''}
            onClick={() => navigate('projects')}
          >
            <FolderCode size={18} />
            Projects
          </button>
          <button
            className={current.page === 'github' ? 'active' : ''}
            onClick={() => navigate('github')}
          >
            <FolderCode size={18} />
            GitHub
          </button>
          {user.isOwner && (
            <button
              className={current.page === 'admin' ? 'active' : ''}
              onClick={() => navigate('admin')}
            >
              <Settings2 size={18} />
              Administration
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="server-status">
            <Server size={15} />
            <span>
              {workerHealthy ? 'Your server is connected' : 'Container worker unavailable'}
            </span>
            <span className={`online-dot ${workerHealthy ? '' : 'offline'}`} />
          </div>
          <div className="account-wrap">
            <button className="account-button" onClick={() => setUserMenu(!userMenu)}>
              <Avatar name={user.displayName} size={32} />
              <span>
                <strong>{user.displayName}</strong>
                <small>{user.isOwner ? 'Site owner' : 'Member'}</small>
              </span>
              <ChevronDown size={14} />
            </button>
            {userMenu && (
              <>
                <div className="menu-dismiss" onClick={() => setUserMenu(false)} />
                <div className="dropdown account-menu">
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
                </div>
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
        {current.page === 'github' ? (
          <GitHubSettings user={user} />
        ) : current.page === 'admin' && user.isOwner ? (
          <Admin onOpen={(id) => navigate('workspace', id)} />
        ) : (
          <Projects user={user} onOpen={(id) => navigate('workspace', id)} />
        )}
      </section>
      {password && (
        <Modal title="Change password" onClose={() => setPassword(false)} small>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const result = await post<{ user: User }>(
                  '/auth/password',
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
                setUser(result.user);
                setPassword(false);
                ui.notify('Password changed. Other sessions were signed out.', 'success');
              } catch (e) {
                ui.notify(errorMessage(e));
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
                autoFocus
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
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => setPassword(false)}>
                Cancel
              </button>
              <button className="button primary">Change password</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
