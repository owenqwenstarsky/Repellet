import { useState, useRef, useEffect } from 'react';
import type { Project, SetupSuggestion, GitHubRepository } from '@repellet/shared';
import { api, post, put, errorMessage } from './api';
import { GitHubPicker } from './GitHub';
import { useUi } from './ui';
import { usePollingField } from './usePollingField';
export function RepositorySetup({
  project,
  onChanged,
  onConfirmed,
}: {
  project: Project;
  onChanged: () => void;
  onConfirmed?: (config: Project['runConfig']) => void;
}) {
  const ui = useUi();
  const [cwd, setCwd] = usePollingField(project.runConfig.cwd),
    [setup, setSetup] = usePollingField(project.setupCommand),
    [command, setCommand] = usePollingField(project.runConfig.command),
    [port, setPort] = usePollingField(project.runConfig.port);
  const [suggestion, setSuggestion] = useState<SetupSuggestion>(),
    [repo, setRepo] = useState<GitHubRepository | null>(null),
    [busy, setBusy] = useState(false);
  const inspection = useRef(0);
  const inFlight = useRef(false);
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
  async function act(fn: () => Promise<void>) {
    if (inFlight.current || project.role !== 'owner' || project.state !== 'running') return;
    inFlight.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div>
      <p>
        {project.repository
          ? `Connected repository: ${project.repository.fullName}`
          : 'Connect a matching GitHub origin to use your account for pull and push.'}
      </p>
      <GitHubPicker value={repo} onSelect={setRepo} />
      <button
        className="button secondary"
        disabled={!repo || busy || project.state !== 'running'}
        onClick={() =>
          act(async () => {
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
      </button>
      <hr />
      <h3>Prepare repository</h3>
      <p>
        Inspect manifests, review commands, and confirm before installing dependencies. Run starts
        only when clicked.
      </p>
      <label>
        Setup working directory
        <input
          value={cwd}
          onChange={(e) => {
            inspection.current++;
            setSuggestion(undefined);
            setCwd(e.target.value);
          }}
        />
      </label>
      <button
        className="button secondary"
        disabled={busy || project.state !== 'running'}
        onClick={() =>
          act(async () => {
            const request = ++inspection.current;
            setSuggestion(undefined);
            const result = await post<SetupSuggestion>(base + '/setup/suggest', { cwd });
            if (request === inspection.current) setSuggestion(result);
          })
        }
      >
        Inspect manifests
      </button>
      {suggestion && (
        <div>
          <p>
            Suggested runtimes: {suggestion.runtimes.join(', ') || 'Choose manually'}. Add missing
            runtimes under Environment before preparation.
          </p>
          {suggestion.warnings.map((w) => (
            <p key={w} className="field-help">
              {w}
            </p>
          ))}
          <button
            className="button secondary"
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
          </button>
        </div>
      )}
      <label>
        Setup command
        <input value={setup} onChange={(e) => setSetup(e.target.value)} maxLength={4096} />
      </label>
      <label>
        Confirmed run command
        <input value={command} onChange={(e) => setCommand(e.target.value)} maxLength={4096} />
      </label>
      <label>
        Confirmed preview port
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => setPort(Number(e.target.value))}
        />
      </label>
      <button
        className="button primary"
        disabled={busy || project.state !== 'running'}
        onClick={() =>
          act(async () => {
            await put(base + '/setup', {
              setupCommand: setup,
              runConfig: { command, cwd, port },
              confirmed: true,
            });
            onConfirmed?.({ command, cwd, port });
            await post(base + '/open');
            // If changing the port required a container restart, preparation is resumed after it opens.
            if (port === project.runConfig.port && setup.trim()) await post(base + '/prepare');
            onChanged();
            ui.notify(
              'Setup confirmed. Dependencies are preparing; Run remains an explicit action.',
              'success',
            );
          })
        }
      >
        Confirm and prepare
      </button>
    </div>
  );
}
