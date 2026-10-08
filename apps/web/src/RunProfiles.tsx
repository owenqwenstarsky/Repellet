import { useEffect, useState } from 'react';
import type { Project, RunProfile, WorkspaceProcess } from '@repellet/shared';
import { runProfileInputSchema } from '@repellet/shared';
import { api, post, put, remove, errorMessage } from './api';
import { Button, Field, LoadError, Section, useUi } from './ui';
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
  const [error, setError] = useState('');
  const { busy, run, alive } = useAsyncAction();
  const ui = useUi();
  const base = `/projects/${project.id}`;
  async function load() {
    try {
      const [next, running] = await Promise.all([
        api<Profile[]>(base + '/run-profiles'),
        api<WorkspaceProcess[]>(base + '/processes'),
      ]);
      if (alive.current) {
        setProfiles(next);
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
    project.role !== 'viewer' && project.state === 'running' && !project.storageExceeded;
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
  }
  return (
    <Section
      title="Run profiles"
      description="Run several services or one-off tasks in the same workspace. Each process has its own terminal output."
    >
      {error && <LoadError message={error} onRetry={load} />}
      <div className="list">
        {profiles.map((profile) => {
          const active = processes.find(
            (process) =>
              process.profileId === profile.id && ['starting', 'running'].includes(process.status),
          );
          const recent = processes.filter((process) => process.profileId === profile.id).at(-1);
          return (
            <div className="list-row" key={profile.id}>
              <div className="list-row-main">
                <strong>{profile.name}</strong>
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
                    disabled={!execute || busy}
                    onClick={() =>
                      run(async () => {
                        await post(`${base}/processes/${active.id}/stop`);
                        await load();
                      })
                    }
                  >
                    Stop {profile.name}
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={!execute || busy || !profile.command.trim()}
                      onClick={() =>
                        run(async () => {
                          await flushOpenDocuments(project.id);
                          await post(`${base}/run-profiles/${profile.id}/start`);
                          await load();
                        })
                      }
                    >
                      Run {profile.name}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!execute || busy || !profile.command.trim()}
                      onClick={() =>
                        run(async () => {
                          await flushOpenDocuments(project.id);
                          await post(`${base}/run-profiles/${profile.id}/start`, { kind: 'task' });
                          await load();
                        })
                      }
                    >
                      Task {profile.name}
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {manage && (
        <form
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
              ui.notify(parsed.error.issues[0]?.message || 'Check profile settings');
              return;
            }
            void run(async () => {
              if (selected) await put(`${base}/run-profiles/${selected}`, parsed.data);
              else await post(base + '/run-profiles', parsed.data);
              edit();
              await load();
              ui.notify('Run profile saved.', 'success');
            });
          }}
        >
          <Field label="Profile name">
            <input
              required
              value={draft.name}
              maxLength={80}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label="Command">
            <input
              required
              value={draft.command}
              maxLength={4096}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            />
          </Field>
          <Field label="Working directory">
            <input
              value={draft.cwd}
              placeholder="Workspace root"
              onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
            />
          </Field>
          <Field label="Environment variable names">
            <input
              value={environmentNames}
              placeholder="PUBLIC_URL, PORT"
              onChange={(e) => setEnvironmentNames(e.target.value)}
            />
          </Field>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.autoStart}
              onChange={(e) => setDraft({ ...draft, autoStart: e.target.checked })}
            />
            Start when the workspace starts
          </label>
          <div className="form-actions">
            {selected && (
              <Button disabled={busy} onClick={() => edit()}>
                New profile
              </Button>
            )}
            {selected && !profiles.find((profile) => profile.id === selected)?.isDefault && (
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await remove(`${base}/run-profiles/${selected}`);
                    edit();
                    await load();
                  })
                }
              >
                Delete profile
              </Button>
            )}
            <Button type="submit" variant="primary" busy={busy}>
              {selected ? 'Save profile' : 'Add profile'}
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
