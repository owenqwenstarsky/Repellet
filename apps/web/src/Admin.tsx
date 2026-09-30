import { useState, useEffect, useRef } from 'react';
import type { User, Project, Limits } from '@repellet/shared';
import {
  UserPlus,
  Users,
  SlidersHorizontal,
  Box,
  Save,
  KeyRound,
  UserX,
  UserCheck,
  Square,
  Loader2,
} from 'lucide-react';
import { api, post, patch, put, errorMessage, formatBytes } from './api';
import { useUi, Modal, Avatar, Status, Spinner } from './ui';
export function Admin({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState('people');
  const [users, setUsers] = useState<User[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const ui = useUi();
  async function load() {
    try {
      const [u, s, p] = await Promise.all([
        api<User[]>('/admin/users'),
        api<{ limits: Limits }>('/admin/settings'),
        api<Project[]>('/admin/projects'),
      ]);
      setUsers(u);
      setLimits(s.limits);
      setProjects(p);
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="dashboard admin-page">
      <header className="page-heading">
        <div>
          <div className="eyebrow">SITE OWNER</div>
          <h1>Administration</h1>
          <p className="muted">Manage the people and resources on your server.</p>
        </div>
        {tab === 'people' && (
          <button className="button primary" onClick={() => setCreating(true)}>
            <UserPlus size={16} />
            Add person
          </button>
        )}
      </header>
      <div className="admin-tabs segment">
        {[
          ['people', 'People', Users],
          ['resources', 'Resources', SlidersHorizontal],
          ['projects', 'All projects', Box],
        ].map(([id, label, Icon]) => (
          <button
            key={id as string}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id as string)}
          >
            {typeof Icon !== 'string' && <Icon size={15} />} {label as string}
          </button>
        ))}
      </div>
      {tab === 'people' && (
        <div className="admin-list">
          {users.map((user) => (
            <div className="admin-user" key={user.id}>
              <Avatar name={user.displayName} size={36} />
              <div>
                <strong>{user.displayName}</strong>
                <small>@{user.username}</small>
              </div>
              <span className="role-label">
                {user.isOwner ? 'Owner' : user.enabled ? 'Member' : 'Disabled'}
              </span>
              <div className="admin-user-actions">
                <button
                  className="button secondary small"
                  onClick={async () => {
                    const password = await ui.ask({
                      title: 'Reset password',
                      description: `Choose a new password for ${user.displayName}. Existing sessions will be revoked.`,
                      label: 'New password (at least 12 characters)',
                      password: true,
                    });
                    if (password)
                      try {
                        await patch('/admin/users/' + user.id, { password });
                        ui.notify('Password reset.', 'success');
                      } catch (e) {
                        ui.notify(errorMessage(e));
                      }
                  }}
                >
                  <KeyRound size={14} />
                  Reset password
                </button>
                {!user.isOwner && (
                  <button
                    className="icon-button"
                    aria-label={`${user.enabled ? 'Disable' : 'Enable'} ${user.displayName}`}
                    onClick={async () => {
                      if (
                        user.enabled &&
                        !(await ui.ask({
                          title: 'Disable account?',
                          description:
                            'This revokes all sessions and live connections. Project files are retained.',
                          confirm: true,
                        }))
                      )
                        return;
                      try {
                        await patch('/admin/users/' + user.id, { enabled: !user.enabled });
                        await load();
                      } catch (e) {
                        ui.notify(errorMessage(e));
                      }
                    }}
                  >
                    {user.enabled ? <UserX size={17} /> : <UserCheck size={17} />}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {tab === 'resources' &&
        (limits ? (
          <form
            className="resource-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (inFlight.current) return;
              inFlight.current = true;
              setBusy(true);
              try {
                await put('/admin/settings', { limits });
                ui.notify('Resource limits updated.', 'success');
              } catch (e) {
                ui.notify(errorMessage(e));
              } finally {
                inFlight.current = false;
                setBusy(false);
              }
            }}
          >
            <h2>Workspace limits</h2>
            <p className="muted">Defaults apply to all projects and update running containers.</p>
            <div className="form-columns">
              {[
                ['cpu', 'CPU cores', 0.25, 64, 0.25],
                ['memoryMb', 'Memory (MiB)', 256, 131072, 128],
                ['storageMb', 'Monitored storage (MiB)', 128, 1048576, 128],
                ['maxActiveProjects', 'Active projects per owner', 1, 100, 1],
                ['idleMinutes', 'Idle shutdown (minutes)', 1, 1440, 1],
              ].map(([key, label, min, max, step]) => (
                <label key={key as string}>
                  {label}
                  <input
                    type="number"
                    required
                    min={min as number}
                    max={max as number}
                    step={step as number}
                    value={limits[key as keyof Limits]}
                    onChange={(e) =>
                      setLimits((v) => ({ ...v!, [key as string]: Number(e.target.value) }))
                    }
                  />
                </label>
              ))}
            </div>
            <p className="resource-note">
              CPU and memory limits are enforced by Docker. Storage is measured periodically;
              terminal writes can briefly exceed the limit. Over-limit projects suspend execution
              and remain available for file cleanup.
            </p>
            <button className="button primary" disabled={busy}>
              {busy ? <Loader2 size={16} className="spin" /> : <Save size={16} />}Save limits
            </button>
          </form>
        ) : (
          <Spinner />
        ))}
      {tab === 'projects' && (
        <div className="admin-project-list">
          {projects.map((p) => (
            <div key={p.id}>
              <button className="project-name" onClick={() => onOpen(p.id)}>
                <Box size={19} />
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.ownerName}</small>
                </span>
              </button>
              <Status state={p.state} />
              <span className="muted">{formatBytes(p.storageBytes)}</span>
              {p.state === 'running' && (
                <button
                  className="button secondary small"
                  onClick={async () => {
                    try {
                      await post(`/projects/${p.id}/stop`);
                      await load();
                    } catch (e) {
                      ui.notify(errorMessage(e));
                    }
                  }}
                >
                  <Square size={12} />
                  Stop workspace
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {creating && (
        <Modal title="Add a person" onClose={() => setCreating(false)} small>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (inFlight.current) return;
              inFlight.current = true;
              setBusy(true);
              try {
                await post('/admin/users', Object.fromEntries(new FormData(e.currentTarget)));
                setCreating(false);
                await load();
                ui.notify('Account created. Share the credentials with the new member.', 'success');
              } catch (e) {
                ui.notify(errorMessage(e));
              } finally {
                inFlight.current = false;
                setBusy(false);
              }
            }}
          >
            <label>
              Display name
              <input name="displayName" autoFocus required maxLength={80} />
            </label>
            <label>
              Username
              <input
                name="username"
                required
                minLength={3}
                maxLength={40}
                pattern="[a-zA-Z0-9_.\-]+"
              />
            </label>
            <label>
              Initial password
              <input
                type="password"
                name="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            <p className="field-help">There’s no public registration or email invitation.</p>
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                <UserPlus size={16} />
                Create account
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
