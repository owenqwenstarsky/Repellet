import { useState } from 'react';
import type { Project, SetupSuggestion, GitHubRepository } from '@repellet/shared';
import { api, post, put, errorMessage } from './api';
import { GitHubPicker } from './GitHub';
import { useUi } from './ui';
export function RepositorySetup({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: () => void;
}) {
  const ui = useUi();
  const [cwd, setCwd] = useState(project.runConfig.cwd),
    [setup, setSetup] = useState(project.setupCommand),
    [command, setCommand] = useState(project.runConfig.command),
    [port, setPort] = useState(project.runConfig.port);
  const [suggestion, setSuggestion] = useState<SetupSuggestion>(),
    [repo, setRepo] = useState<GitHubRepository | null>(null),
    [busy, setBusy] = useState(false);
  const base = `/projects/${project.id}`;
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
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
      <GitHubPicker onSelect={setRepo} />
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
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
      </label>
      <button
        className="button secondary"
        disabled={busy || project.state !== 'running'}
        onClick={() =>
          act(async () => {
            setSuggestion(await post(base + '/setup/suggest', { cwd }));
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
