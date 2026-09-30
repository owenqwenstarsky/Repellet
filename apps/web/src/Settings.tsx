import { useState, useEffect, useRef } from 'react';
import {
  environmentSchema,
  runConfigSchema,
  projectCreateSchema,
  safeRelativePath,
} from '@repellet/shared';
import type { Project, User, Runtime } from '@repellet/shared';
import {
  Save,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Users,
  Box,
  SlidersHorizontal,
  Download,
  Copy,
  Loader2,
  UserPlus,
} from 'lucide-react';
import { api, put, patch, post, remove, errorMessage } from './api';
import { Modal, useUi, Spinner, Avatar, LoadError } from './ui';
import { RuntimePicker } from './Projects';
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
  const [tab, setTab] = useState('general');
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [command, setCommand] = useState(project.runConfig.command);
  const [cwd, setCwd] = useState(project.runConfig.cwd);
  const [port, setPort] = useState(project.runConfig.port);
  const [runtimes, setRuntimes] = useState<Runtime[]>(project.runtimes);
  const [variables, setVariables] = useState<{ key: string; value: string }[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [members, setMembers] = useState<{ user: User; role: string }[] | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const [environmentError, setEnvironmentError] = useState('');
  const [membersError, setMembersError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const alive = useRef(true);
  const pending = useRef(false);
  const environmentRequest = useRef(0);
  const membersRequest = useRef(0);
  const runtimeSnapshot = useRef(project.runtimes);
  const fields = useRef<HTMLDivElement>(null);
  const dismiss = () => {
    alive.current = false;
    onClose();
  };
  const ui = useUi();
  const manage = project.role === 'owner';
  const base = `/projects/${project.id}`;
  async function loadMembers() {
    const request = ++membersRequest.current;
    setMembersError('');
    try {
      const [list, people] = await Promise.all([
        api<{ user: User; role: string }[]>(base + '/members'),
        manage ? api<User[]>('/users') : Promise.resolve([]),
      ]);
      if (alive.current && request === membersRequest.current) {
        setMembers(list);
        setUsers(people);
      }
    } catch (e) {
      if (alive.current && request === membersRequest.current) setMembersError(errorMessage(e));
    }
  }
  async function loadEnvironment() {
    const request = ++environmentRequest.current;
    setEnvironmentError('');
    try {
      const snapshot = await api<{ variables: Record<string, string>; runtimes?: Runtime[] }>(
        base + '/environment',
      );
      if (alive.current && request === environmentRequest.current) {
        runtimeSnapshot.current = snapshot.runtimes || project.runtimes;
        setRuntimes(runtimeSnapshot.current);
        setVariables(Object.entries(snapshot.variables).map(([key, value]) => ({ key, value })));
      }
    } catch (e) {
      if (alive.current && request === environmentRequest.current)
        setEnvironmentError(errorMessage(e));
    }
  }
  useEffect(() => {
    alive.current = true;
    void loadMembers();
    if (manage) void loadEnvironment();
    return () => {
      alive.current = false;
      environmentRequest.current++;
      membersRequest.current++;
    };
  }, []);
  async function memberAction(operation: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await operation();
      if (alive.current) await loadMembers();
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (pending.current || !manage || (tab === 'environment' && variables === null)) return;
    if (
      [...fields.current!.querySelectorAll<HTMLInputElement>('input')].some(
        (input) => !input.reportValidity(),
      )
    )
      return;
    const submittedTab = tab;
    const submitted = { name, description, runConfig: { command, cwd, port } };
    const values = (variables || []).map((v) => ({ ...v }));
    const submittedRuntimes = [...runtimes];
    const errors: Record<string, string> = {};
    if (tab === 'general') {
      const result = projectCreateSchema
        .pick({ name: true, description: true })
        .extend({ runConfig: runConfigSchema })
        .safeParse(submitted);
      if (!result.success)
        for (const issue of result.error.issues) errors[String(issue.path.at(-1))] = issue.message;
      try {
        safeRelativePath(submitted.runConfig.cwd);
      } catch (e) {
        errors.cwd = errorMessage(e);
      }
    } else {
      const result = environmentSchema.safeParse(
        Object.fromEntries(values.map((v) => [v.key, v.value])),
      );
      if (!result.success)
        for (const issue of result.error.issues)
          errors[String(issue.path[0] || 'environment')] = issue.message;
      if (new Set(values.map((v) => v.key)).size !== values.length)
        errors.environment = 'Variable names must be unique.';
      if (!submittedRuntimes.length) errors.environment = 'Choose at least one runtime.';
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length) return;
    pending.current = true;
    setBusy(true);
    try {
      if (submittedTab === 'general') {
        await patch(base, submitted);
        ui.notify('Project settings saved.', 'success');
      } else if (submittedTab === 'environment') {
        const changed =
          [...submittedRuntimes].sort().join() !== [...runtimeSnapshot.current].sort().join();
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
      }
      if (alive.current) {
        onChanged();
        if (submittedTab === 'environment') dismiss();
      }
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <Modal title="Project settings" onClose={dismiss}>
      <div ref={fields}>
        <div className="settings-tabs">
          {[
            ['general', 'General', SlidersHorizontal],
            ['environment', 'Environment', Box],
            ['members', 'People', Users],
          ]
            .filter(([id]) => manage || id !== 'environment')
            .map(([id, label, Icon]) => (
              <button
                disabled={busy}
                aria-pressed={tab === id}
                key={id as string}
                className={tab === id ? 'active' : ''}
                onClick={() => setTab(id as string)}
              >
                {typeof Icon !== 'string' && <Icon size={16} />} {label as string}
              </button>
            ))}
        </div>
        {tab === 'general' && (
          <div>
            <label>
              Project name
              <input
                value={name}
                disabled={!manage || busy}
                required
                aria-invalid={!!fieldErrors.name}
                aria-describedby={fieldErrors.name ? 'settings-name-error' : undefined}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
              {fieldErrors.name && (
                <p id="settings-name-error" className="form-error" role="alert">
                  {fieldErrors.name}
                </p>
              )}
            </label>
            <label>
              Description
              <input
                aria-invalid={!!fieldErrors.description}
                aria-describedby={
                  fieldErrors.description ? 'settings-description-error' : undefined
                }
                value={description}
                disabled={!manage || busy}
                maxLength={500}
                onChange={(e) => setDescription(e.target.value)}
              />
              {fieldErrors.description && (
                <p id="settings-description-error" className="form-error" role="alert">
                  {fieldErrors.description}
                </p>
              )}
            </label>
            <div className="form-divider" />
            <label>
              Run command
              <input
                maxLength={4096}
                className="mono-input"
                aria-invalid={!!fieldErrors.command}
                aria-describedby={fieldErrors.command ? 'settings-command-error' : undefined}
                value={command}
                disabled={!manage || busy}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npm run dev -- --host 0.0.0.0"
              />
              {fieldErrors.command && (
                <p id="settings-command-error" className="form-error" role="alert">
                  {fieldErrors.command}
                </p>
              )}
            </label>
            <div className="form-columns">
              <label>
                Working directory
                <input
                  maxLength={1024}
                  aria-invalid={!!fieldErrors.cwd}
                  aria-describedby={fieldErrors.cwd ? 'settings-cwd-error' : undefined}
                  value={cwd}
                  disabled={!manage || busy}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="Workspace root"
                />
                {fieldErrors.cwd && (
                  <p id="settings-cwd-error" className="form-error" role="alert">
                    {fieldErrors.cwd}
                  </p>
                )}
              </label>
              <label>
                Preview port
                <input
                  required
                  type="number"
                  min={1024}
                  max={65535}
                  aria-invalid={!!fieldErrors.port}
                  aria-describedby={fieldErrors.port ? 'settings-port-error' : undefined}
                  value={port}
                  disabled={!manage || busy}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
                {fieldErrors.port && (
                  <p id="settings-port-error" className="form-error" role="alert">
                    {fieldErrors.port}
                  </p>
                )}
              </label>
            </div>
            <p className="field-help">
              Your server must listen on 0.0.0.0. Changing its port stops a running workspace.
            </p>
            <div className="form-divider" />
            <div className="settings-tools">
              <button
                className="button secondary"
                onClick={() => window.open('/api' + base + '/export', '_blank', 'noopener')}
                disabled={project.state !== 'running'}
              >
                <Download size={15} />
                Export files (.tar)
              </button>
              <button
                className="button secondary"
                disabled={busy || project.state !== 'running'}
                onClick={async () => {
                  if (pending.current) return;
                  pending.current = true;
                  setBusy(true);
                  try {
                    const p = await post<Project>(base + '/duplicate');
                    if (alive.current) onDuplicate(p.id);
                  } catch (e) {
                    ui.notify(errorMessage(e));
                  } finally {
                    pending.current = false;
                    if (alive.current) setBusy(false);
                  }
                }}
              >
                <Copy size={15} />
                Duplicate
              </button>
            </div>
          </div>
        )}
        {tab === 'environment' && (
          <>
            <div className="label">Runtime selection</div>
            <p className="field-help">
              Changing runtimes rebuilds the container and keeps your files.
            </p>
            <RuntimePicker
              value={runtimes}
              onChange={setRuntimes}
              disabled={busy || variables === null}
            />
            <div className="form-divider" />
            <div className="env-heading">
              <div className="label">Environment variables</div>
              <button
                className="icon-button"
                aria-label={visible ? 'Hide variable values' : 'Show variable values'}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="field-help">
              Encrypted on the server. Editors can read them through terminals and running apps.
            </p>
            {environmentError && <LoadError message={environmentError} onRetry={loadEnvironment} />}
            {variables === null ? (
              environmentError ? null : (
                <Spinner />
              )
            ) : (
              <div className="env-list">
                {variables.map((v, i) => (
                  <div className="env-row" key={i}>
                    <input
                      disabled={busy}
                      required
                      pattern="[A-Za-z_][A-Za-z0-9_]*"
                      aria-invalid={!!fieldErrors[v.key]}
                      aria-label={`Variable name ${i + 1}`}
                      value={v.key}
                      placeholder="VARIABLE_NAME"
                      onChange={(e) =>
                        setVariables((values) =>
                          values!.map((old, n) =>
                            n === i ? { ...old, key: e.target.value } : old,
                          ),
                        )
                      }
                    />
                    <input
                      disabled={busy}
                      maxLength={32768}
                      aria-invalid={!!fieldErrors[v.key]}
                      aria-label={`Variable value ${i + 1}`}
                      type={visible ? 'text' : 'password'}
                      value={v.value}
                      placeholder="Value"
                      onChange={(e) =>
                        setVariables((values) =>
                          values!.map((old, n) =>
                            n === i ? { ...old, value: e.target.value } : old,
                          ),
                        )
                      }
                    />
                    <button
                      className="icon-button"
                      disabled={busy}
                      aria-label={`Remove variable ${i + 1}`}
                      onClick={() => setVariables((v) => v!.filter((_, n) => n !== i))}
                    >
                      <Trash2 size={15} />
                    </button>
                    {fieldErrors[v.key] && (
                      <p className="form-error" role="alert">
                        {fieldErrors[v.key]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            <button
              className="text-button"
              disabled={variables === null || busy || variables.length >= 100}
              onClick={() => setVariables((v) => [...(v || []), { key: '', value: '' }])}
            >
              <Plus size={15} />
              Add variable
            </button>
          </>
        )}
        {tab === 'members' && (
          <>
            <p className="field-help">
              Editors can edit, run code, and use shared terminals. Viewers can read files, observe
              terminals, and open previews.
            </p>
            <div className="member-list">
              {membersError && <LoadError message={membersError} onRetry={loadMembers} />}
              {!members && !membersError && <Spinner />}
              {members?.map((m) => (
                <div className="member-row" key={m.user.id}>
                  <Avatar name={m.user.displayName} />
                  <span>
                    <strong title={m.user.displayName}>{m.user.displayName}</strong>
                    <small title={m.user.username}>@{m.user.username}</small>
                  </span>
                  {manage && m.role !== 'owner' ? (
                    <>
                      <select
                        aria-label={`Role for ${m.user.displayName}`}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) => {
                          const nextRole = e.target.value;
                          void memberAction(() =>
                            put(base + '/members', { userId: m.user.id, role: nextRole }),
                          );
                        }}
                      >
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button
                        className="icon-button"
                        aria-label={`Remove ${m.user.displayName}`}
                        disabled={busy}
                        onClick={() => memberAction(() => remove(base + '/members/' + m.user.id))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </>
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
                  void memberAction(async () => {
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
                  <option value="">Choose a person…</option>
                  {users
                    .filter((u) => !members?.some((m) => m.user.id === u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName} (@{u.username})
                      </option>
                    ))}
                </select>
                <select
                  aria-label="Invite role"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                >
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button
                  className="button primary"
                  disabled={!selectedUser || busy || members === null}
                >
                  <UserPlus size={15} />
                  Add
                </button>
              </form>
            )}
          </>
        )}
      </div>
      {Object.entries(fieldErrors)
        .filter(([key]) => tab === 'environment' && !variables?.some((v) => v.key === key))
        .map(([key, message]) => (
          <p className="form-error" role="alert" key={key}>
            {key}: {message}
          </p>
        ))}
      <div className="modal-actions">
        <button className="button secondary" onClick={dismiss}>
          Close
        </button>
        {manage && tab !== 'members' && (
          <button
            className="button primary"
            disabled={busy || (variables === null && tab === 'environment')}
            onClick={save}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Save size={16} />}Save changes
          </button>
        )}
      </div>
    </Modal>
  );
}
