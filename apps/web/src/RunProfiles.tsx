import { useEffect, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { Project, RunProfile, WorkspaceProcess } from '@repellet/shared';
import { runProfileInputSchema } from '@repellet/shared';
import { api, post, put, remove, errorMessage } from './api';
import { Button, Field, LoadError, FormError, MenuButton, MenuItem, useUi } from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { flushOpenDocuments } from './documentSaves';
type Profile = RunProfile & { isDefault: boolean; previewTargetId?: string | null };
const blank = {
  name: '',
  command: '',
  cwd: '',
  environmentKeys: [] as string[],
  autoStart: false,
  previewTargetId: undefined as string | undefined,
};
export function RunProfiles({ project }: { project: Project }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [processes, setProcesses] = useState<WorkspaceProcess[]>([]);
  const [draft, setDraft] = useState(blank);
  const [environmentNames, setEnvironmentNames] = useState('');
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const { busy, run, alive } = useAsyncAction((e) => setActionError(errorMessage(e)));
  const ui = useUi();
  const base = `/projects/${project.id}`;
  async function load() {
    try {
      const [next, running] = await Promise.all([
        api<Profile[]>(base + '/run-profiles'),
        api<WorkspaceProcess[]>(base + '/processes'),
      ]);
      if (alive.current) {
        setProfiles(next.filter((p) => !p.isDefault));
        setProcesses(running);
        setError('');
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [project.id]);
  const manage = project.role === 'owner';
  const execute =
    project.role !== 'viewer' &&
    project.state === 'running' &&
    !project.storageExceeded &&
    ['none', 'ready'].includes(project.preparation.status);
  const executionReason =
    project.role === 'viewer'
      ? 'Viewers can observe commands. Only owners and editors can run them.'
      : project.state !== 'running'
        ? 'Start the workspace to run commands.'
        : project.storageExceeded
          ? 'Free up project storage to run commands.'
          : !['none', 'ready'].includes(project.preparation.status)
            ? 'Install dependencies before running commands.'
            : '';
  const activeFor = (id: string) =>
    processes.find((p) => p.profileId === id && ['starting', 'running'].includes(p.status));
  function edit(profile?: Profile) {
    setEnvironmentNames(profile?.environmentKeys.join(', ') || '');
    setSelected(profile?.id || '');
    setDraft(
      profile
        ? {
            name: profile.name,
            command: profile.command,
            cwd: profile.cwd,
            environmentKeys: profile.environmentKeys,
            autoStart: profile.autoStart,
            previewTargetId: profile.previewTargetId || undefined,
          }
        : blank,
    );
    setErrors({});
    setActionError('');
    setAdvanced(false);
    setEditing(true);
  }
  function start(profile: Profile, task = false) {
    setActionError('');
    void run(async () => {
      await flushOpenDocuments(project.id);
      if (!alive.current) return;
      if (task) await post(`${base}/run-profiles/${profile.id}/start`, { kind: 'task' });
      else await post(`${base}/run-profiles/${profile.id}/start`);
      await load();
    });
  }
  return (
    <details className="run-disclosure additional-commands">
      <summary>Additional commands ({profiles.length})</summary>
      <div className="run-disclosure-content">
        <p className="field-help">
          Run other services or tasks alongside your main app, such as a backend server or tests.
          These do not replace the main Run button.
        </p>
        <p className="field-help">
          Run is for services that keep running. Run as task, in each command’s actions menu, is for
          commands expected to finish, such as tests or builds.
        </p>
        {executionReason && <p className="field-help">{executionReason}</p>}
        {error && <LoadError message={error} onRetry={load} />}
        <div className="list">
          {profiles.map((profile) => {
            const active = activeFor(profile.id);
            const recent = processes.filter((p) => p.profileId === profile.id).at(-1);
            return (
              <div className="list-row run-command-row" key={profile.id}>
                <div className="list-row-main">
                  <strong>{profile.name}</strong>
                  <code>{profile.command}</code>
                  <small>{active?.status || recent?.status || 'Not started'}</small>
                </div>
                <div className="list-row-actions">
                  {manage && (
                    <Button size="sm" disabled={busy} onClick={() => edit(profile)}>
                      Edit {profile.name}
                    </Button>
                  )}
                  {active ? (
                    <Button
                      size="sm"
                      disabled={project.role === 'viewer' || project.state !== 'running' || busy}
                      onClick={() => {
                        setActionError('');
                        void run(async () => {
                          await post(`${base}/processes/${active.id}/stop`);
                          await load();
                        });
                      }}
                    >
                      Stop {profile.name}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={!execute || busy || !profile.command.trim()}
                      onClick={() => start(profile)}
                    >
                      Run {profile.name}
                    </Button>
                  )}
                  <MenuButton
                    label={`Actions for ${profile.name}`}
                    icon={<MoreHorizontal size={16} />}
                  >
                    <MenuItem
                      disabled={!execute || busy || !!active || !profile.command.trim()}
                      onSelect={() => start(profile, true)}
                    >
                      Run as task
                    </MenuItem>
                  </MenuButton>
                </div>
              </div>
            );
          })}
        </div>
        {!profiles.length && !error && (
          <p className="field-help">
            Your main Run command is enough for most projects. Add another only when you need it.
          </p>
        )}
        {actionError && <FormError>{actionError}</FormError>}
        {manage && !editing && (
          <Button size="sm" disabled={busy} onClick={() => edit()}>
            Add command
          </Button>
        )}
        {manage && editing && (
          <form
            className="run-command-editor"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = runProfileInputSchema.safeParse({
                ...draft,
                environmentKeys: environmentNames
                  .split(',')
                  .map((key) => key.trim())
                  .filter(Boolean),
              });
              if (!parsed.success) {
                const next = Object.fromEntries(
                  parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
                );
                setErrors(next);
                if (next.cwd || next.environmentKeys) setAdvanced(true);
                return;
              }
              setErrors({});
              setActionError('');
              void run(async () => {
                if (selected) await put(`${base}/run-profiles/${selected}`, parsed.data);
                else await post(base + '/run-profiles', parsed.data);
                if (!alive.current) return;
                setEditing(false);
                await load();
                ui.notify('Command saved.', 'success');
              });
            }}
          >
            <h3>{selected ? 'Edit command' : 'Add command'}</h3>
            <Field
              label="Name"
              error={errors.name}
              help="A short label to identify this command, such as Backend or Tests."
            >
              <input
                required
                disabled={busy}
                value={draft.name}
                maxLength={80}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field
              label="Command"
              error={errors.command}
              help="The command to execute in the workspace. Saving it does not run it."
            >
              <input
                className="mono-input"
                required
                disabled={busy}
                value={draft.command}
                maxLength={4096}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              />
            </Field>
            <details
              className="run-disclosure"
              open={advanced}
              onToggle={(e) => setAdvanced(e.currentTarget.open)}
            >
              <summary>Advanced</summary>
              <div className="run-disclosure-content">
                <Field
                  label="Project folder"
                  error={errors.cwd}
                  help="The folder for this command only, relative to your project. Leave blank for the project root. Example: backend."
                >
                  <input
                    disabled={busy}
                    value={draft.cwd}
                    placeholder="Project root"
                    onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
                  />
                </Field>
                <Field
                  label="Environment variable names"
                  error={errors.environmentKeys}
                  help="Choose which saved project variables this additional command receives. Enter names separated by commas, such as PORT, API_URL, not their values. Leave blank to pass no saved project variables."
                >
                  <input
                    disabled={busy}
                    value={environmentNames}
                    placeholder="PORT, API_URL"
                    onChange={(e) => setEnvironmentNames(e.target.value)}
                  />
                </Field>
                <Field
                  label="Start automatically"
                  help="Starts this command when the workspace starts. Dependencies must already be prepared."
                >
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={draft.autoStart}
                    onChange={(e) => setDraft({ ...draft, autoStart: e.target.checked })}
                  />
                </Field>
              </div>
            </details>
            {selected && activeFor(selected) && (
              <p className="field-help">Stop this command before deleting it.</p>
            )}
            <div className="form-actions">
              {selected && (
                <Button
                  disabled={busy || !!activeFor(selected)}
                  onClick={() => {
                    setActionError('');
                    void run(async () => {
                      await remove(`${base}/run-profiles/${selected}`);
                      if (alive.current) setEditing(false);
                      await load();
                    });
                  }}
                >
                  Delete command
                </Button>
              )}
              <Button disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" busy={busy}>
                Save command
              </Button>
            </div>
          </form>
        )}
      </div>
    </details>
  );
}
