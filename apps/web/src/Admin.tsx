import { useState, useEffect, useRef } from 'react';
import { userCreateSchema } from '@repellet/shared';
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
} from 'lucide-react';
import { api, post, patch, put, errorMessage, formatBytes } from './api';
import {
  useUi,
  Modal,
  Avatar,
  Status,
  Spinner,
  LoadError,
  Button,
  IconButton,
  Field,
  FormRow,
  PageHeader,
  Section,
  Tabs,
  TabPanel,
} from './ui';
import { useAsyncAction } from './components/useAsyncAction';
type Tab = 'people' | 'resources' | 'projects';
const limitFields: [keyof Limits, string, number, number, number][] = [
  ['cpu', 'CPU cores', 0.25, 64, 0.25],
  ['memoryMb', 'Memory (MiB)', 256, 131072, 128],
  ['storageMb', 'Monitored storage (MiB)', 128, 1048576, 128],
  ['maxActiveProjects', 'Active projects per owner', 1, 100, 1],
  ['idleMinutes', 'Idle shutdown (minutes)', 1, 1440, 1],
];
export function Admin({ onOpen }: { onOpen: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('people');
  const [users, setUsers] = useState<User[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const dialogVersion = useRef(0);
  const { busy, run } = useAsyncAction();
  const closeCreate = () => {
    dialogVersion.current++;
    setCreating(false);
  };
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
      setLoadError('');
    } catch (e) {
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function resetPassword(user: User) {
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
  }
  async function toggleUser(user: User) {
    if (
      user.enabled &&
      !(await ui.ask({
        title: 'Disable account?',
        description: 'This revokes all sessions and live connections. Project files are retained.',
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
  }
  return (
    <main className="dashboard">
      <PageHeader
        title="Administration"
        description="Manage people and resources on your server."
      />
      <Tabs
        label="Administration sections"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'people', label: 'People', icon: Users },
          { id: 'resources', label: 'Resources', icon: SlidersHorizontal },
          { id: 'projects', label: 'All projects', icon: Box },
        ]}
      />
      <TabPanel>
        {loadError && <LoadError message={loadError} onRetry={load} />}
        {loading && <Spinner />}
        {!loading && tab === 'people' && (
          <Section
            title={`People (${users.length})`}
            description="Accounts are created here. There’s no public registration or email invitation."
            actions={
              <Button
                variant="primary"
                icon={<UserPlus size={15} />}
                onClick={() => {
                  dialogVersion.current++;
                  setCreateErrors({});
                  setCreating(true);
                }}
              >
                Add person
              </Button>
            }
          >
            <div className="list">
              {users.map((user) => (
                <div className="list-row" key={user.id}>
                  <Avatar name={user.displayName} size={34} />
                  <div className="list-row-main">
                    <strong className="truncate" title={user.displayName}>
                      {user.displayName}
                    </strong>
                    <small className="truncate" title={user.username}>
                      @{user.username}
                    </small>
                  </div>
                  <span className="role-label">
                    {user.isOwner ? 'Owner' : user.enabled ? 'Member' : 'Disabled'}
                  </span>
                  <div className="list-row-actions">
                    <IconButton
                      label={`Reset password for ${user.displayName}`}
                      icon={<KeyRound size={15} />}
                      onClick={() => resetPassword(user)}
                    />
                    {!user.isOwner && (
                      <IconButton
                        label={`${user.enabled ? 'Disable' : 'Enable'} ${user.displayName}`}
                        icon={user.enabled ? <UserX size={16} /> : <UserCheck size={16} />}
                        onClick={() => toggleUser(user)}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}
        {!loading &&
          tab === 'resources' &&
          (limits ? (
            <form
              className="resource-form"
              onSubmit={(e) => {
                e.preventDefault();
                const submittedLimits = { ...limits };
                void run(async () => {
                  await put('/admin/settings', { limits: submittedLimits });
                  ui.notify('Resource limits updated.', 'success');
                });
              }}
            >
              <Section
                title="Workspace limits"
                description="Defaults apply to all projects and update running containers. CPU and memory are enforced by Docker. Storage is measured periodically, so terminal writes can briefly exceed it; over-limit projects suspend execution but stay available for cleanup."
              >
                <FormRow columns={2}>
                  {limitFields.map(([key, label, min, max, step]) => (
                    <Field key={key} label={label}>
                      <input
                        type="number"
                        required
                        min={min}
                        max={max}
                        step={step}
                        value={limits[key]}
                        onChange={(e) =>
                          setLimits((v) => ({ ...v!, [key]: Number(e.target.value) }))
                        }
                      />
                    </Field>
                  ))}
                </FormRow>
                <div className="form-actions start">
                  <Button type="submit" variant="primary" busy={busy} icon={<Save size={15} />}>
                    Save limits
                  </Button>
                </div>
              </Section>
            </form>
          ) : loadError ? null : (
            <Spinner />
          ))}
        {!loading && tab === 'projects' && (
          <Section
            title={`All projects (${projects.length})`}
            description="Every project on this server, including ones you aren’t a member of."
          >
            <div className="list">
              {projects.map((p) => (
                <div className="list-row" key={p.id}>
                  <button className="project-name list-row-main" onClick={() => onOpen(p.id)}>
                    <span className="project-icon">
                      <Box size={17} />
                    </span>
                    <span className="project-text">
                      <strong className="truncate" title={p.name}>
                        {p.name}
                      </strong>
                      <small className="truncate" title={p.ownerName}>
                        {p.ownerName}
                      </small>
                    </span>
                  </button>
                  <Status state={p.state} />
                  <span className="admin-storage">{formatBytes(p.storageBytes)}</span>
                  <div className="list-row-actions admin-stop">
                    {p.state === 'running' && (
                      <Button
                        size="sm"
                        icon={<Square size={11} />}
                        onClick={async () => {
                          try {
                            await post(`/projects/${p.id}/stop`);
                            await load();
                          } catch (e) {
                            ui.notify(errorMessage(e));
                          }
                        }}
                      >
                        Stop workspace
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}
      </TabPanel>
      {creating && (
        <Modal title="Add a person" onClose={closeCreate} small>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const version = dialogVersion.current;
              const result = userCreateSchema.safeParse(
                Object.fromEntries(new FormData(e.currentTarget)),
              );
              if (!result.success) {
                setCreateErrors(
                  Object.fromEntries(
                    result.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
                  ),
                );
                return;
              }
              setCreateErrors({});
              const values = result.data;
              void run(async () => {
                await post('/admin/users', values);
                if (dialogVersion.current === version) closeCreate();
                await load();
                ui.notify('Account created. Share the credentials with the new member.', 'success');
              });
            }}
          >
            <Field id="person-displayName" label="Display name" error={createErrors.displayName}>
              <input name="displayName" data-autofocus required maxLength={80} />
            </Field>
            <Field
              id="person-username"
              label="Username"
              error={createErrors.username}
              help="Letters, numbers, dots, dashes and underscores."
            >
              <input
                name="username"
                required
                minLength={3}
                maxLength={40}
                pattern="[a-zA-Z0-9_.\-]+"
              />
            </Field>
            <Field
              id="person-password"
              label="Initial password"
              error={createErrors.password}
              help="At least 12 characters. Share it with them directly."
            >
              <input
                type="password"
                name="password"
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </Field>
            <div className="modal-actions">
              <Button onClick={closeCreate}>Cancel</Button>
              <Button type="submit" variant="primary" busy={busy} icon={<UserPlus size={15} />}>
                Create account
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
