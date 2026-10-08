import { useState, useRef, useEffect } from 'react';
import type { Project, RunProfile, SetupSuggestion } from '@repellet/shared';
import { runConfigSchema, safeRelativePath } from '@repellet/shared';
import { Save, PackageCheck, ScanSearch } from 'lucide-react';
import { api, post, patch, errorMessage } from './api';
import { useUi, Button, Field, FormRow, Section, Banner, FormError } from './ui';
import { useAsyncAction } from './components/useAsyncAction';
import { flushOpenDocuments } from './documentSaves';
import { usePollingField } from './usePollingField';
import { preparationLabels } from './workspace/PreparationLogsPanel';
export function useRunSettings(project: Project) {
  const [cwd, setCwd] = usePollingField(project.runConfig.cwd),
    [setup, setSetup] = usePollingField(project.setupCommand),
    [command, setCommand] = usePollingField(project.runConfig.command),
    [port, setPort] = usePollingField(project.runConfig.port);
  const [remoteAutoStart, setRemoteAutoStart] = useState<boolean>();
  const [autoStart, setAutoStart] = usePollingField(remoteAutoStart);
  const [profileError, setProfileError] = useState('');
  const [error, setError] = useState('');
  const action = useAsyncAction((e) => setError(errorMessage(e)));
  async function loadProfile() {
    try {
      const profiles = await api<(RunProfile & { isDefault: boolean })[]>(
        `/projects/${project.id}/run-profiles`,
      );
      if (!action.alive.current) return;
      const profile = profiles.find((p) => p.isDefault);
      if (!profile)
        throw new Error('Main Run settings are unavailable. Retry to load automatic start.');
      setRemoteAutoStart(profile.autoStart);
      setProfileError('');
    } catch (e) {
      if (action.alive.current) setProfileError(errorMessage(e));
    }
  }
  useEffect(() => {
    void loadProfile();
  }, [project.id, project.updatedAt]);
  return {
    cwd,
    setCwd,
    setup,
    setSetup,
    command,
    setCommand,
    port,
    setPort,
    autoStart,
    setAutoStart,
    remoteAutoStart,
    setRemoteAutoStart,
    profileError,
    loadProfile,
    error,
    setError,
    ...action,
  };
}
type SetupProps = { project: Project; onChanged: () => void; onViewLogs?: () => void };
export function RepositorySetup(props: SetupProps) {
  const settings = useRunSettings(props.project);
  return <RepositorySetupForm {...props} settings={settings} />;
}
export function RepositorySetupForm({
  project,
  onChanged,
  onViewLogs,
  settings,
}: SetupProps & { settings: ReturnType<typeof useRunSettings> }) {
  const ui = useUi();
  const {
    cwd,
    setCwd,
    setup,
    setSetup,
    command,
    setCommand,
    port,
    setPort,
    busy,
    run,
    alive,
    autoStart,
    setAutoStart,
    remoteAutoStart,
    setRemoteAutoStart,
    profileError,
    loadProfile,
    error,
    setError,
  } = settings;
  const [suggestion, setSuggestion] = useState<SetupSuggestion>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const inspection = useRef(0);
  const manage = project.role === 'owner';
  const running = project.state === 'running';
  const preparing =
    ['files', 'installing'].includes(project.preparation.status) ||
    (running && project.preparation.status === 'pending');
  const dirty =
    cwd !== project.runConfig.cwd ||
    setup !== project.setupCommand ||
    command !== project.runConfig.command ||
    port !== project.runConfig.port ||
    autoStart !== remoteAutoStart;
  const examples = project.runtimes.includes('node')
    ? ['npm run dev', 'npm ci']
    : project.runtimes.includes('python')
      ? ['python app.py', 'python -m pip install -r requirements.txt']
      : project.runtimes.includes('go')
        ? ['go run .', 'go mod download']
        : project.runtimes.includes('rust')
          ? ['cargo run', 'cargo fetch']
          : ['your-start-command', 'your-install-command'];
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
  function save() {
    if (!manage || preparing) return;
    const next: Record<string, string> = {};
    const result = runConfigSchema.safeParse({ command, cwd, port });
    if (!result.success)
      for (const issue of result.error.issues) next[String(issue.path.at(-1))] = issue.message;
    try {
      safeRelativePath(cwd);
    } catch (e) {
      next.cwd = errorMessage(e);
    }
    if (setup.length > 4096) next.setup = 'Use at most 4096 characters.';
    setErrors(next);
    if (next.cwd || next.port) setAdvanced(true);
    if (Object.keys(next).length) return;
    setError('');
    void run(async () => {
      await patch(base, {
        runConfig: { command, cwd, port },
        setupCommand: setup,
        ...(autoStart !== undefined ? { runAutoStart: autoStart } : {}),
      });
      if (!alive.current) return;
      setSetup(setup.trim());
      setCwd(safeRelativePath(cwd));
      setRemoteAutoStart(autoStart);
      await onChanged();
      ui.notify('Run settings saved. No commands were started.', 'success');
    });
  }
  const installReason =
    project.role === 'viewer'
      ? 'Only owners and editors can install dependencies.'
      : dirty
        ? 'Save your changes before installing dependencies.'
        : !running
          ? 'Start the workspace to install dependencies.'
          : project.storageExceeded
            ? 'Free up project storage before installing dependencies.'
            : preparing
              ? 'Preparation is already in progress.'
              : !setup.trim() && (!project.starterId || project.preparation.scaffolded)
                ? 'No install command is configured.'
                : '';
  const disabled = !manage || busy || preparing;
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Section
        title="Run"
        description="Configure your main app here. Save your settings, install dependencies if needed, then use Run in the workspace."
      >
        <Field
          id="run-command"
          label="Run command"
          error={errors.command}
          help={`Starts your app when you click Run. Example: ${examples[0]}.`}
        >
          <input
            className="mono-input"
            maxLength={4096}
            value={command}
            disabled={disabled}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={examples[0]}
          />
        </Field>
        <Field
          id="setup-command"
          label="Install command (optional)"
          error={errors.setup}
          help={`Installs the packages your project needs. Example: ${examples[1]}. Leave blank if no installation is needed. Saving this command does not run it.`}
        >
          <input
            className="mono-input"
            value={setup}
            disabled={disabled}
            onChange={(e) => setSetup(e.target.value)}
            maxLength={4096}
            placeholder={examples[1]}
          />
        </Field>
        {manage && (
          <div className="run-detection">
            <Button
              size="sm"
              icon={<ScanSearch size={14} />}
              disabled={busy || !running || preparing}
              aria-describedby="detect-help"
              onClick={() => {
                setError('');
                void run(async () => {
                  const request = ++inspection.current;
                  setSuggestion(undefined);
                  await flushOpenDocuments(project.id);
                  if (!alive.current) return;
                  const result = await post<SetupSuggestion>(base + '/setup/suggest', { cwd });
                  if (alive.current && request === inspection.current) setSuggestion(result);
                });
              }}
            >
              Detect commands
            </Button>
            <p className="field-help" id="detect-help">
              Suggest commands from your project files for you to review.
              {!running && ' Start the workspace to detect commands.'}
            </p>
          </div>
        )}
        {suggestion && (
          <Banner
            tone="info"
            title="Suggested commands"
            actions={
              <Button
                size="sm"
                disabled={disabled}
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
            <span>
              Run: <code>{suggestion.runConfig.command || 'Not detected'}</code>
            </span>
            <span>
              Install: <code>{suggestion.setupCommand || 'None'}</code>
            </span>
            <span>
              Folder: {suggestion.runConfig.cwd || 'Project root'} · Port:{' '}
              {suggestion.runConfig.port}
            </span>
            <span>
              Runtimes: {suggestion.runtimes.join(', ') || 'choose manually'}. Add missing runtimes
              under Environment before installing.
            </span>
            {suggestion.warnings.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </Banner>
        )}
        <details
          className="run-disclosure"
          open={advanced}
          onToggle={(e) => setAdvanced(e.currentTarget.open)}
        >
          <summary>
            Advanced{' '}
            <span>
              {cwd || 'Project root'} · Port {port}
            </span>
          </summary>
          <div className="run-disclosure-content">
            <FormRow columns={2}>
              <Field
                id="run-cwd"
                label="Project folder"
                error={errors.cwd}
                help="The folder where both commands run, relative to your project. Leave blank for the project root. Example: frontend."
              >
                <input
                  className="mono-input"
                  maxLength={1024}
                  value={cwd}
                  disabled={disabled}
                  placeholder="Project root"
                  onChange={(e) => {
                    inspection.current++;
                    setSuggestion(undefined);
                    setCwd(e.target.value);
                  }}
                />
              </Field>
              <Field
                id="run-port"
                label="Preview port"
                error={errors.port}
                help="The port your app listens on, such as 3000. This must match your app’s configuration; changing it here does not change your app. Your server must listen on 0.0.0.0 to be reachable."
              >
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
            <Field
              id="run-auto"
              label="Start automatically"
              help="Starts this command when the workspace starts. Dependencies must already be prepared."
            >
              <input
                type="checkbox"
                checked={autoStart ?? false}
                disabled={disabled || autoStart === undefined}
                onChange={(e) => setAutoStart(e.target.checked)}
              />
            </Field>
            {profileError && (
              <p role="alert">
                {profileError}{' '}
                <Button size="sm" onClick={loadProfile}>
                  Retry automatic start settings
                </Button>
              </p>
            )}
          </div>
        </details>
        {port !== project.runConfig.port && running && (
          <Banner tone="warning" title="Saving this port will stop the workspace">
            Start the workspace again after saving to use the new preview port.
          </Banner>
        )}
        {error && <FormError>{error}</FormError>}
        {manage && (
          <div className="form-actions start">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={preparing || !dirty}
              icon={<Save size={15} />}
            >
              Save changes
            </Button>
            <span className="field-help">
              {preparing
                ? 'Wait for preparation to finish before saving.'
                : dirty
                  ? 'You have unsaved changes.'
                  : 'All changes saved.'}
            </span>
          </div>
        )}
      </Section>
      <Section title="Dependencies">
        <p role="status">{preparationLabels[project.preparation.status]}</p>
        {project.preparation.error && <FormError>{project.preparation.error}</FormError>}
        <div className="form-actions start">
          <Button
            icon={<PackageCheck size={15} />}
            disabled={!!installReason || busy}
            aria-describedby="install-help"
            onClick={() => {
              if (installReason) return;
              setError('');
              void run(async () => {
                await flushOpenDocuments(project.id);
                if (!alive.current) return;
                await post(base + '/prepare');
                if (!alive.current) return;
                await onChanged();
                ui.notify(
                  'Dependency preparation requested. See Preparation Logs for progress.',
                  'success',
                );
              });
            }}
          >
            Install dependencies
          </Button>
          {onViewLogs && <Button onClick={onViewLogs}>View preparation logs</Button>}
        </div>
        <p id="install-help" className="field-help">
          {installReason ||
            'Runs the saved install command. Your app starts separately when you click Run.'}
        </p>
      </Section>
    </form>
  );
}
