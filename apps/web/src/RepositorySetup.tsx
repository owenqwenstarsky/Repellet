import { useState, useRef, useEffect } from 'react';
import type { Project, SetupSuggestion } from '@repellet/shared';
import { runConfigSchema, safeRelativePath } from '@repellet/shared';
import { Save, PackageCheck, ScanSearch } from 'lucide-react';
import { post, put, patch, errorMessage } from './api';
import { useUi, Button, Field, FormRow, Section, Banner } from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { flushOpenDocuments } from './documentSaves';
import { usePollingField } from './usePollingField';
export function useRunSettings(project: Project) {
  const [cwd, setCwd] = usePollingField(project.runConfig.cwd),
    [setup, setSetup] = usePollingField(project.setupCommand),
    [command, setCommand] = usePollingField(project.runConfig.command),
    [port, setPort] = usePollingField(project.runConfig.port);
  const action = useAsyncAction();
  return { cwd, setCwd, setup, setSetup, command, setCommand, port, setPort, ...action };
}
type SetupProps = { project: Project; onChanged: () => void };
// The single place to edit how a project runs: command, working directory, port and setup.
export function RepositorySetup(props: SetupProps) {
  const settings = useRunSettings(props.project);
  return <RepositorySetupForm {...props} settings={settings} />;
}
export function RepositorySetupForm({
  project,
  onChanged,
  settings,
}: SetupProps & { settings: ReturnType<typeof useRunSettings> }) {
  const ui = useUi();
  const { cwd, setCwd, setup, setSetup, command, setCommand, port, setPort, busy, run, alive } =
    settings;
  const [suggestion, setSuggestion] = useState<SetupSuggestion>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const inspection = useRef(0);
  const manage = project.role === 'owner';
  const running = project.state === 'running';
  useEffect(() => {
    inspection.current++;
    setSuggestion(undefined);
  }, [cwd]);
  useEffect(
    () => () => {
      inspection.current++;
    },
    [],
  );
  const base = `/projects/${project.id}`;
  function validate() {
    if (!form.current?.reportValidity()) return null;
    const next: Record<string, string> = {};
    const result = runConfigSchema.safeParse({ command, cwd, port });
    if (!result.success)
      for (const issue of result.error.issues) next[String(issue.path.at(-1))] = issue.message;
    try {
      safeRelativePath(cwd);
    } catch (e) {
      next.cwd = errorMessage(e);
    }
    setErrors(next);
    return Object.keys(next).length ? null : { command, cwd, port };
  }
  function save() {
    if (!manage) return;
    const runConfig = validate();
    if (!runConfig) return;
    void run(async () => {
      await patch(base, { runConfig });
      if (alive.current) onChanged();
      ui.notify('Run settings saved.', 'success');
    });
  }
  function confirm() {
    if (!manage || !running) return;
    const runConfig = validate();
    if (!runConfig) return;
    void run(async () => {
      await flushOpenDocuments(project.id);
      if (!alive.current) return;
      await put(base + '/setup', { setupCommand: setup, runConfig, confirmed: true });
      await post(base + '/open');
      // If changing the port required a container restart, preparation is resumed after it opens.
      if (port === project.runConfig.port && setup.trim()) await post(base + '/prepare');
      if (alive.current) onChanged();
      ui.notify(
        'Setup confirmed. Dependencies are preparing; Run remains an explicit action.',
        'success',
      );
    });
  }
  const disabled = !manage || busy;
  return (
    <form
      ref={form}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Section
        title="Run configuration"
        description="What the Run button starts. Your server must listen on 0.0.0.0. Changing the port stops a running workspace."
      >
        <Field id="run-command" label="Run command" error={errors.command}>
          <input
            className="mono-input"
            maxLength={4096}
            value={command}
            disabled={disabled}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npm run dev -- --host 0.0.0.0"
          />
        </Field>
        <FormRow columns={2}>
          <Field id="run-cwd" label="Working directory" error={errors.cwd}>
            <input
              className="mono-input"
              maxLength={1024}
              value={cwd}
              disabled={disabled}
              onChange={(e) => {
                inspection.current++;
                setSuggestion(undefined);
                setCwd(e.target.value);
              }}
              placeholder="Workspace root"
            />
          </Field>
          <Field id="run-port" label="Preview port" error={errors.port}>
            <input
              required
              type="number"
              min={1024}
              max={65535}
              value={port}
              disabled={disabled}
              onChange={(e) => setPort(Number(e.target.value))}
            />
          </Field>
        </FormRow>
        {manage && (
          <div className="form-actions start">
            <Button type="submit" busy={busy} icon={<Save size={15} />}>
              Save changes
            </Button>
          </div>
        )}
      </Section>
      <Section
        title="Dependencies"
        description="Inspect manifests in the working directory, review the commands, then confirm to install. Nothing runs until you click Run."
        actions={
          manage && (
            <Button
              size="sm"
              icon={<ScanSearch size={14} />}
              disabled={busy || !running}
              onClick={() =>
                run(async () => {
                  const request = ++inspection.current;
                  setSuggestion(undefined);
                  await flushOpenDocuments(project.id);
                  if (!alive.current) return;
                  const result = await post<SetupSuggestion>(base + '/setup/suggest', { cwd });
                  if (request === inspection.current) setSuggestion(result);
                })
              }
            >
              Inspect manifests
            </Button>
          )
        }
      >
        {suggestion && (
          <Banner
            tone="info"
            title={`Suggested runtimes: ${suggestion.runtimes.join(', ') || 'choose manually'}`}
            actions={
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setSetup(suggestion.setupCommand);
                  setCommand(suggestion.runConfig.command);
                  setPort(suggestion.runConfig.port);
                  setCwd(suggestion.runConfig.cwd);
                  inspection.current++;
                  setSuggestion(undefined);
                }}
              >
                Use suggestions
              </Button>
            }
          >
            <span>Add missing runtimes under Environment before preparing.</span>
            {suggestion.warnings.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </Banner>
        )}
        <Field
          id="setup-command"
          label="Setup command"
          help={!running && manage ? 'Start the workspace to inspect or prepare.' : undefined}
        >
          <input
            className="mono-input"
            value={setup}
            disabled={disabled}
            onChange={(e) => setSetup(e.target.value)}
            maxLength={4096}
            placeholder="npm ci"
          />
        </Field>
        {manage && (
          <div className="form-actions start">
            <Button
              variant="primary"
              icon={<PackageCheck size={15} />}
              disabled={busy || !running}
              onClick={confirm}
            >
              Confirm and prepare
            </Button>
          </div>
        )}
      </Section>
    </form>
  );
}
