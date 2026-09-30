import { useState, useEffect, useRef } from 'react';
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
import { Modal, useUi, Spinner, Avatar } from './ui';
import { RepositorySetup } from './RepositorySetup';
import { RuntimePicker } from './Projects';
import { usePollingField } from './usePollingField';
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
  const [tab, setTab] = useState(
    project.role === 'owner' && !project.runConfig.command ? 'repository' : 'general',
  );
  const [name, setName] = usePollingField(project.name);
  const [description, setDescription] = usePollingField(project.description);
  const [command, setCommand] = usePollingField(project.runConfig.command);
  const [cwd, setCwd] = usePollingField(project.runConfig.cwd);
  const [port, setPort] = usePollingField(project.runConfig.port);
  const [runtimes, setRuntimes] = usePollingField<Runtime[]>(project.runtimes);
  const [variables, setVariables] = useState<{ key: string; value: string }[] | null>(null);
  const [environmentError, setEnvironmentError] = useState('');
  const [environmentAttempt, setEnvironmentAttempt] = useState(0);
  const [visible, setVisible] = useState(false);
  const [members, setMembers] = useState<{ user: User; role: string }[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [role, setRole] = useState('editor');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const inviteInFlight = useRef(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const ui = useUi();
  const manage = project.role === 'owner';
  const base = `/projects/${project.id}`;
  useEffect(() => {
    if (!manage && ['environment', 'repository'].includes(tab)) setTab('general');
  }, [manage, tab]);
  async function loadMembers() {
    try {
      setMembers(await api(base + '/members'));
      if (manage) setUsers(await api('/users'));
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  useEffect(() => {
    void loadMembers();
  }, [base, manage]);
  useEffect(() => {
    if (!manage) {
      setVariables(null);
      return;
    }
    let disposed = false;
    setVariables(null);
    setEnvironmentError('');
    api<{ variables: Record<string, string> }>(base + '/environment')
      .then((v) => {
        if (!disposed)
          setVariables(Object.entries(v.variables).map(([key, value]) => ({ key, value })));
      })
      .catch((e) => {
        if (!disposed) setEnvironmentError(errorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, [base, manage, environmentAttempt]);
  async function save() {
    if (
      !manage ||
      inFlight.current ||
      (tab === 'environment' && (variables === null || environmentError))
    )
      return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (tab === 'general') {
        await patch(base, { name, description, runConfig: { command, cwd, port } });
        ui.notify('Project settings saved.', 'success');
      } else if (tab === 'environment') {
        if (!runtimes.length) throw new Error('Choose at least one runtime.');
        const values = variables || [];
        if (values.some((v) => !v.key.trim())) throw new Error('Enter a name for each variable.');
        if (new Set(values.map((v) => v.key)).size !== values.length)
          throw new Error('Variable names must be unique.');
        const changed = [...runtimes].sort().join() !== [...project.runtimes].sort().join();
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
        await put(base + '/environment', {
          runtimes,
          variables: Object.fromEntries(values.map((v) => [v.key, v.value])),
        });
        ui.notify(
          changed
            ? 'Environment rebuild started.'
            : 'Variables saved. Open new terminals or restart your app to use them.',
          'success',
        );
      }
      onChanged();
      if (tab === 'environment') onClose();
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal title="Project settings" onClose={onClose}>
      <div className="settings-tabs">
        {[
          ['general', 'General', SlidersHorizontal],
          ['environment', 'Environment', Box],
          ['members', 'People', Users],
          ['repository', 'Repository setup', Box],
        ]
          .filter(([id]) => manage || (id !== 'environment' && id !== 'repository'))
          .map(([id, label, Icon]) => (
            <button
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
              disabled={!manage}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Description
            <input
              value={description}
              disabled={!manage}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="form-divider" />
          <label>
            Run command
            <input
              className="mono-input"
              value={command}
              disabled={!manage}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npm run dev -- --host 0.0.0.0"
            />
          </label>
          <div className="form-columns">
            <label>
              Working directory
              <input
                value={cwd}
                disabled={!manage}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="Workspace root"
              />
            </label>
            <label>
              Preview port
              <input
                type="number"
                min={1024}
                max={65535}
                value={port}
                disabled={!manage}
                onChange={(e) => setPort(Number(e.target.value))}
              />
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
                setBusy(true);
                try {
                  const p = await post<Project>(base + '/duplicate');
                  onDuplicate(p.id);
                } catch (e) {
                  ui.notify(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Copy size={15} />
              Duplicate
            </button>
          </div>
        </div>
      )}
      {manage && tab === 'environment' && (
        <>
          <div className="label">Runtime selection</div>
          <p className="field-help">
            Changing runtimes rebuilds the container and keeps your files.
          </p>
          <RuntimePicker
            value={runtimes}
            onChange={setRuntimes}
            disabled={variables === null || busy}
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
          {environmentError ? (
            <p className="form-error" role="alert">
              {environmentError}{' '}
              <button className="text-button" onClick={() => setEnvironmentAttempt((v) => v + 1)}>
                Retry environment
              </button>
            </p>
          ) : variables === null ? (
            <Spinner />
          ) : (
            <div className="env-list">
              {variables.map((v, i) => (
                <div className="env-row" key={i}>
                  <input
                    aria-label={`Variable name ${i + 1}`}
                    value={v.key}
                    placeholder="VARIABLE_NAME"
                    onChange={(e) =>
                      setVariables((values) =>
                        values!.map((old, n) => (n === i ? { ...old, key: e.target.value } : old)),
                      )
                    }
                  />
                  <input
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
                    aria-label={`Remove variable ${i + 1}`}
                    onClick={() => setVariables((v) => v!.filter((_, n) => n !== i))}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            className="text-button"
            disabled={variables === null || busy}
            onClick={() => setVariables((v) => v && [...v, { key: '', value: '' }])}
          >
            <Plus size={15} />
            Add variable
          </button>
        </>
      )}
      {manage && tab === 'repository' && (
        <RepositorySetup
          project={project}
          onChanged={onChanged}
          onConfirmed={(config) => {
            setCommand(config.command);
            setCwd(config.cwd);
            setPort(config.port);
          }}
        />
      )}
      {tab === 'members' && (
        <>
          <p className="field-help">
            Editors can edit, run code, and use shared terminals. Viewers can read files, observe
            terminals, and open previews.
          </p>
          <div className="member-list">
            {members.map((m) => (
              <div className="member-row" key={m.user.id}>
                <Avatar name={m.user.displayName} />
                <span>
                  <strong>{m.user.displayName}</strong>
                  <small>@{m.user.username}</small>
                </span>
                {manage && m.role !== 'owner' ? (
                  <>
                    <select
                      aria-label={`Role for ${m.user.displayName}`}
                      value={m.role}
                      onChange={async (e) => {
                        try {
                          await put(base + '/members', { userId: m.user.id, role: e.target.value });
                          await loadMembers();
                        } catch (e) {
                          ui.notify(errorMessage(e));
                        }
                      }}
                    >
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${m.user.displayName}`}
                      onClick={async () => {
                        try {
                          await remove(base + '/members/' + m.user.id);
                          await loadMembers();
                        } catch (e) {
                          ui.notify(errorMessage(e));
                        }
                      }}
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
              onSubmit={async (e) => {
                e.preventDefault();
                if (!manage || !selectedUser || inviteInFlight.current) return;
                inviteInFlight.current = true;
                setInviteBusy(true);
                try {
                  await put(base + '/members', { userId: selectedUser, role });
                  setSelectedUser('');
                  await loadMembers();
                  ui.notify('Project access added.', 'success');
                } catch (e) {
                  ui.notify(errorMessage(e));
                } finally {
                  inviteInFlight.current = false;
                  setInviteBusy(false);
                }
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
                  .filter((u) => !members.some((m) => m.user.id === u.id))
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
              <button className="button primary" disabled={!selectedUser || inviteBusy}>
                <UserPlus size={15} />
                Add
              </button>
            </form>
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
        {manage && !['members', 'repository'].includes(tab) && (
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
