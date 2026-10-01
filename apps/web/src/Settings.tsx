import { useState, useEffect, useRef } from 'react';
import { environmentSchema, projectCreateSchema } from '@repellet/shared';
import type { Project, User, Runtime, GitHubRepository } from '@repellet/shared';
import {
  Save,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Users,
  Layers,
  Play,
  SlidersHorizontal,
  Download,
  Copy,
  UserPlus,
  Square,
  Link2,
} from 'lucide-react';
import { api, put, patch, post, remove, errorMessage } from './api';
import {
  Modal,
  useUi,
  Spinner,
  Avatar,
  LoadError,
  Button,
  IconButton,
  Field,
  FormError,
  Section,
  Tabs,
  TabPanel,
} from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { RuntimePicker } from './Projects';
import { RepositorySetup } from './RepositorySetup';
import { GitHubPicker } from './GitHub';
import { usePollingField } from './usePollingField';
type Tab = 'general' | 'run' | 'environment' | 'members';
export function ProjectSettings({
  project,
  onClose,
  onChanged,
  onDuplicate,
}: {
  project: Project;
  onClose: () => void;
  onChanged: () => void;
  onDuplicate: (id: string) => void;
}) {
  const manage = project.role === 'owner';
  const [tab, setTab] = useState<Tab>(manage && !project.runConfig.command ? 'run' : 'general');
  const { busy, run, alive, dispose } = useAsyncAction();
  const dismiss = () => {
    dispose();
    onClose();
  };
  // Tab state lives here so unsaved edits survive switching tabs, and data loads up front.
  const details = useDetails(project);
  const environment = useEnvironment(project, alive);
  const people = useMembers(project, alive);
  useEffect(() => {
    if (!manage && tab === 'environment') setTab('general');
  }, [manage, tab]);
  return (
    <Modal title="Project settings" onClose={dismiss}>
      <Tabs
        label="Project settings sections"
        value={tab}
        onChange={setTab}
        disabled={busy}
        className="modal-tabs"
        items={[
          { id: 'general', label: 'General', icon: SlidersHorizontal },
          { id: 'run', label: 'Run & setup', icon: Play },
          ...(manage ? [{ id: 'environment' as const, label: 'Environment', icon: Layers }] : []),
          { id: 'members', label: 'People', icon: Users },
        ]}
      />
      <TabPanel>
        {tab === 'general' && (
          <General
            details={details}
            project={project}
            busy={busy}
            run={run}
            alive={alive}
            onChanged={onChanged}
            onDuplicate={onDuplicate}
          />
        )}
        {tab === 'run' && <RepositorySetup project={project} onChanged={onChanged} />}
        {manage && tab === 'environment' && (
          <Environment
            environment={environment}
            project={project}
            busy={busy}
            run={run}
            alive={alive}
            onChanged={onChanged}
            onSaved={dismiss}
          />
        )}
        {tab === 'members' && (
          <Members people={people} project={project} busy={busy} run={run} alive={alive} />
        )}
      </TabPanel>
    </Modal>
  );
}
type Shared = {
  project: Project;
  busy: boolean;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  alive: { current: boolean };
};
function useDetails(project: Project) {
  const [name, setName] = usePollingField(project.name);
  const [description, setDescription] = usePollingField(project.description);
  const [errors, setErrors] = useState<Record<string, string>>({});
  return { name, setName, description, setDescription, errors, setErrors };
}
function General({
  details: { name, setName, description, setDescription, errors, setErrors },
  project,
  busy,
  run,
  alive,
  onChanged,
  onDuplicate,
}: Shared & {
  details: ReturnType<typeof useDetails>;
  onChanged: () => void;
  onDuplicate: (id: string) => void;
}) {
  const ui = useUi();
  const manage = project.role === 'owner';
  const editable = project.role !== 'viewer';
  const running = project.state === 'running';
  const base = `/projects/${project.id}`;
  const [repo, setRepo] = useState<GitHubRepository | null>(null);
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!manage || !e.currentTarget.reportValidity()) return;
          const submitted = { name, description };
          const result = projectCreateSchema
            .innerType()
            .pick({ name: true, description: true })
            .safeParse(submitted);
          const next: Record<string, string> = {};
          if (!result.success)
            for (const issue of result.error.issues)
              next[String(issue.path.at(-1))] = issue.message;
          setErrors(next);
          if (Object.keys(next).length) return;
          void run(async () => {
            await patch(base, submitted);
            ui.notify('Project settings saved.', 'success');
            if (alive.current) onChanged();
          });
        }}
      >
        <Section title="Details">
          <Field id="settings-name" label="Project name" error={errors.name}>
            <input
              value={name}
              disabled={!manage || busy}
              required
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field id="settings-description" label="Description" error={errors.description}>
            <input
              value={description}
              disabled={!manage || busy}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {manage && (
            <div className="form-actions start">
              <Button type="submit" busy={busy} icon={<Save size={15} />}>
                Save changes
              </Button>
            </div>
          )}
        </Section>
      </form>
      {manage && (
        <Section
          title="GitHub remote"
          description={
            project.repository
              ? `Connected to ${project.repository.fullName}. Pull and push use your GitHub account.`
              : 'Connect a matching GitHub origin so pull and push use your GitHub account.'
          }
        >
          <GitHubPicker value={repo} onSelect={setRepo} />
          <div className="form-actions start">
            <Button
              icon={<Link2 size={15} />}
              disabled={!repo || busy || !running}
              onClick={() =>
                run(async () => {
                  await put(base + '/repository', {
                    repositoryId: repo!.id,
                    installationId: repo!.installationId,
                  });
                  onChanged();
                  ui.notify('Repository connected.', 'success');
                })
              }
            >
              Connect matching remote
            </Button>
          </div>
        </Section>
      )}
      <Section title="Project">
        <div className="section-actions">
          <Button
            icon={<Download size={15} />}
            onClick={() => window.open('/api' + base + '/export', '_blank', 'noopener')}
            disabled={!running}
          >
            Export files (.tar)
          </Button>
          <Button
            icon={<Copy size={15} />}
            disabled={busy || !running}
            onClick={() =>
              run(async () => {
                const p = await post<Project>(base + '/duplicate');
                if (alive.current) onDuplicate(p.id);
              })
            }
          >
            Duplicate
          </Button>
          {editable && (
            <Button
              icon={<Square size={13} />}
              disabled={busy || !running}
              onClick={async () => {
                if (
                  await ui.ask({
                    title: 'Stop workspace?',
                    description: 'This stops terminals and running apps. Files are kept.',
                    confirm: true,
                  })
                )
                  void run(async () => {
                    await post(base + '/stop');
                    onChanged();
                  });
              }}
            >
              Stop workspace
            </Button>
          )}
        </div>
      </Section>
    </>
  );
}
function useEnvironment(project: Project, alive: { current: boolean }) {
  const manage = project.role === 'owner';
  const base = `/projects/${project.id}`;
  const [runtimes, setRuntimes] = usePollingField<Runtime[]>(project.runtimes);
  const [variables, setVariables] = useState<{ key: string; value: string }[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const request = useRef(0);
  const snapshot = useRef(project.runtimes);
  async function load() {
    const current = ++request.current;
    setLoadError('');
    try {
      const value = await api<{ variables: Record<string, string>; runtimes?: Runtime[] }>(
        base + '/environment',
      );
      if (alive.current && current === request.current) {
        snapshot.current = value.runtimes || project.runtimes;
        setRuntimes(snapshot.current);
        setVariables(Object.entries(value.variables).map(([key, value]) => ({ key, value })));
      }
    } catch (e) {
      if (alive.current && current === request.current) setLoadError(errorMessage(e));
    }
  }
  useEffect(() => {
    if (manage) void load();
    else setVariables(null);
    return () => {
      request.current++;
    };
  }, [base, manage]);
  const loaded = variables !== null && !loadError;
  return {
    runtimes,
    setRuntimes,
    variables,
    setVariables,
    visible,
    setVisible,
    loadError,
    errors,
    setErrors,
    snapshot,
    load,
    loaded,
  };
}
function Environment({
  environment: {
    runtimes,
    setRuntimes,
    variables,
    setVariables,
    visible,
    setVisible,
    loadError,
    errors,
    setErrors,
    snapshot,
    load,
    loaded,
  },
  project,
  busy,
  run,
  alive,
  onChanged,
  onSaved,
}: Shared & {
  environment: ReturnType<typeof useEnvironment>;
  onChanged: () => void;
  onSaved: () => void;
}) {
  const ui = useUi();
  const base = `/projects/${project.id}`;
  const update = (i: number, change: Partial<{ key: string; value: string }>) =>
    setVariables((values) => values!.map((old, n) => (n === i ? { ...old, ...change } : old)));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!loaded || !e.currentTarget.reportValidity()) return;
        const values = variables!.map((v) => ({ ...v }));
        const submittedRuntimes = [...runtimes];
        const next: Record<string, string> = {};
        const result = environmentSchema.safeParse(
          Object.fromEntries(values.map((v) => [v.key, v.value])),
        );
        if (!result.success)
          for (const issue of result.error.issues)
            next[String(issue.path[0] || 'environment')] = issue.message;
        if (new Set(values.map((v) => v.key)).size !== values.length)
          next.environment = 'Variable names must be unique.';
        if (!submittedRuntimes.length) next.environment = 'Choose at least one runtime.';
        setErrors(next);
        if (Object.keys(next).length) return;
        void run(async () => {
          const changed =
            [...submittedRuntimes].sort().join() !== [...snapshot.current].sort().join();
          if (
            changed &&
            !(await ui.ask({
              title: 'Rebuild environment?',
              description:
                'This stops the workspace and rebuilds its tools. Your project files and home directory will be kept.',
              confirm: true,
            }))
          )
            return;
          if (!alive.current) return;
          await put(base + '/environment', {
            runtimes: submittedRuntimes,
            variables: Object.fromEntries(values.map((v) => [v.key, v.value])),
          });
          ui.notify(
            changed
              ? 'Environment rebuild started.'
              : 'Variables saved. Open new terminals or restart your app to use them.',
            'success',
          );
          if (alive.current) {
            onChanged();
            onSaved();
          }
        });
      }}
    >
      <Section
        title="Runtimes"
        description="Changing runtimes rebuilds the container and keeps your files."
      >
        <RuntimePicker value={runtimes} onChange={setRuntimes} disabled={busy || !loaded} />
      </Section>
      <Section
        title="Variables"
        description="Encrypted on the server. Editors can read them through terminals and running apps."
        actions={
          <IconButton
            label={visible ? 'Hide variable values' : 'Show variable values'}
            icon={visible ? <EyeOff size={15} /> : <Eye size={15} />}
            onClick={() => setVisible(!visible)}
          />
        }
      >
        {loadError && (
          <LoadError message={loadError} onRetry={load} retryLabel="Retry environment" />
        )}
        {variables === null ? (
          loadError ? null : (
            <Spinner />
          )
        ) : (
          <div className="env-list">
            {variables.map((v, i) => (
              <div className="env-row" key={i}>
                <input
                  className="mono-input"
                  disabled={busy}
                  required
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  aria-invalid={!!errors[v.key]}
                  aria-label={`Variable name ${i + 1}`}
                  value={v.key}
                  placeholder="VARIABLE_NAME"
                  onChange={(e) => update(i, { key: e.target.value })}
                />
                <input
                  className="mono-input"
                  disabled={busy}
                  maxLength={32768}
                  aria-invalid={!!errors[v.key]}
                  aria-label={`Variable value ${i + 1}`}
                  type={visible ? 'text' : 'password'}
                  value={v.value}
                  placeholder="Value"
                  onChange={(e) => update(i, { value: e.target.value })}
                />
                <IconButton
                  label={`Remove variable ${i + 1}`}
                  icon={<Trash2 size={14} />}
                  disabled={busy}
                  onClick={() => setVariables((v) => v!.filter((_, n) => n !== i))}
                />
                {errors[v.key] && (
                  <p className="field-error" role="alert">
                    {errors[v.key]}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        <Button
          variant="link"
          disabled={!loaded || busy || variables!.length >= 100}
          onClick={() => setVariables((v) => [...(v || []), { key: '', value: '' }])}
        >
          <Plus size={14} />
          Add variable
        </Button>
        {Object.entries(errors)
          .filter(([key]) => !variables?.some((v) => v.key === key))
          .map(([key, message]) => (
            <FormError key={key}>
              {key}: {message}
            </FormError>
          ))}
        <div className="form-actions start">
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!loaded}
            icon={<Save size={15} />}
          >
            Save changes
          </Button>
        </div>
      </Section>
    </form>
  );
}
function useMembers(project: Project, alive: { current: boolean }) {
  const manage = project.role === 'owner';
  const base = `/projects/${project.id}`;
  const [members, setMembers] = useState<{ user: User; role: string }[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [role, setRole] = useState('editor');
  const [loadError, setLoadError] = useState('');
  const request = useRef(0);
  async function load() {
    const current = ++request.current;
    setLoadError('');
    try {
      const [list, people] = await Promise.all([
        api<{ user: User; role: string }[]>(base + '/members'),
        manage ? api<User[]>('/users') : Promise.resolve([]),
      ]);
      if (alive.current && current === request.current) {
        setMembers(list);
        setUsers(people);
      }
    } catch (e) {
      if (alive.current && current === request.current) setLoadError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [base, manage]);
  return {
    members,
    users,
    selectedUser,
    setSelectedUser,
    role,
    setRole,
    loadError,
    load,
  };
}
function Members({
  people: { members, users, selectedUser, setSelectedUser, role, setRole, loadError, load },
  project,
  busy,
  run,
  alive,
}: Shared & { people: ReturnType<typeof useMembers> }) {
  const manage = project.role === 'owner';
  const base = `/projects/${project.id}`;
  const change = (operation: () => Promise<unknown>) =>
    run(async () => {
      await operation();
      if (alive.current) await load();
    });
  return (
    <Section
      title="People"
      description="Editors can edit, run code, and use shared terminals. Viewers can read files, observe terminals, and open previews."
    >
      {loadError && <LoadError message={loadError} onRetry={load} />}
      {!members && !loadError && <Spinner />}
      <div className="list">
        {members?.map((m) => (
          <div className="list-row" key={m.user.id}>
            <Avatar name={m.user.displayName} />
            <div className="list-row-main">
              <strong className="truncate" title={m.user.displayName}>
                {m.user.displayName}
              </strong>
              <small className="truncate" title={m.user.username}>
                @{m.user.username}
              </small>
            </div>
            {manage && m.role !== 'owner' ? (
              <div className="list-row-actions">
                <select
                  className="role-select"
                  aria-label={`Role for ${m.user.displayName}`}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => {
                    const nextRole = e.target.value;
                    void change(() =>
                      put(base + '/members', { userId: m.user.id, role: nextRole }),
                    );
                  }}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <IconButton
                  label={`Remove ${m.user.displayName}`}
                  icon={<Trash2 size={14} />}
                  disabled={busy}
                  onClick={() => change(() => remove(base + '/members/' + m.user.id))}
                />
              </div>
            ) : (
              <span className="role-label">{m.role}</span>
            )}
          </div>
        ))}
      </div>
      {manage && (
        <form
          className="invite-form"
          onSubmit={(e) => {
            e.preventDefault();
            const values = { userId: selectedUser, role };
            void change(async () => {
              await put(base + '/members', values);
              if (alive.current) setSelectedUser('');
            });
          }}
        >
          <select
            aria-label="User to invite"
            required
            value={selectedUser}
            onChange={(e) => setSelectedUser(e.target.value)}
          >
            <option value="">Add a person…</option>
            {users
              .filter((u) => !members?.some((m) => m.user.id === u.id))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} (@{u.username})
                </option>
              ))}
          </select>
          <select
            className="role-select"
            aria-label="Invite role"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <Button
            type="submit"
            variant="primary"
            disabled={!selectedUser || busy || members === null}
            icon={<UserPlus size={15} />}
          >
            Add
          </Button>
        </form>
      )}
    </Section>
  );
}
