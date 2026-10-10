import { useState, useEffect, useRef } from 'react';
import type { Project, User, Runtime, GitHubRepository, SetupSuggestion } from '@repellet/shared';
import { runtimeCatalog, starterCatalog, projectCreateSchema } from '@repellet/shared';
import { Plus, Search, Code2, MoreHorizontal, Check, Pencil, Trash2 } from 'lucide-react';
import { GitHubPicker } from './GitHub';
import { api, post, patch, remove, errorMessage } from './api';
import {
  Modal,
  Status,
  Spinner,
  useUi,
  LoadError,
  MenuButton,
  MenuItem,
  Button,
  Field,
  FormError,
  PageHeader,
  SegmentedControl,
} from './ui';
import { useAsyncAction } from './components/useAsyncAction';
export function RuntimePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: Runtime[];
  onChange: (v: Runtime[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="runtime-picker">
      {runtimeCatalog.map((r) => (
        <button
          type="button"
          disabled={disabled}
          aria-pressed={value.includes(r.id)}
          className={`runtime-option ${value.includes(r.id) ? 'selected' : ''}`}
          key={r.id}
          onClick={() =>
            onChange(value.includes(r.id) ? value.filter((v) => v !== r.id) : [...value, r.id])
          }
        >
          <span className={`runtime-glyph ${r.id}`}>
            {r.id === 'python' ? 'Py' : r.id === 'node' ? 'JS' : r.id === 'go' ? 'Go' : 'Rs'}
          </span>
          <span>
            <strong>{r.name}</strong>
            <small>
              {r.version} · {r.tools}
            </small>
          </span>
          <span className="runtime-check">{value.includes(r.id) && <Check size={13} />}</span>
        </button>
      ))}
    </div>
  );
}
type Filter = 'all' | 'mine' | 'shared';
export function Projects({ user, onOpen }: { user: User; onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const ui = useUi();
  async function load() {
    try {
      setProjects(await api('/projects'));
      setLoadError('');
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  const filtered = projects?.filter(
    (p) =>
      (p.name + ' ' + p.description).toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'mine' && p.ownerId === user.id) ||
        (filter === 'shared' && p.ownerId !== user.id)),
  );
  const running = projects?.filter((p) => p.running === true).length || 0;
  async function rename(p: Project) {
    const name = await ui.ask({
      title: 'Rename project',
      value: p.name,
      label: 'Project name',
      maxLength: 80,
      pattern: '.*\\S.*',
    });
    if (name)
      try {
        await patch(`/projects/${p.id}`, { name });
        await load();
      } catch (e) {
        ui.notify(errorMessage(e));
      }
  }
  async function destroy(p: Project) {
    if (
      await ui.ask({
        title: 'Delete project?',
        description: `This permanently removes ${p.name}, its files, and its environment.`,
        confirm: true,
        danger: true,
      })
    )
      try {
        await remove(`/projects/${p.id}`);
        await load();
      } catch (e) {
        ui.notify(errorMessage(e));
      }
  }
  return (
    <main className="dashboard">
      <PageHeader
        title="Projects"
        count={projects?.length ?? '—'}
        description={
          projects?.length
            ? `${running} running · Projects are private until you share them.`
            : 'Pick up where you left off, or start something new.'
        }
        actions={
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            Create project
          </Button>
        }
      />
      <div className="project-toolbar">
        <SegmentedControl
          label="Filter projects"
          value={filter}
          onChange={setFilter}
          options={[
            ['all', 'All projects'],
            ['mine', 'Owned by me'],
            ['shared', 'Shared with me'],
          ]}
        />
        <div className="search-field">
          <Search size={15} />
          <input
            aria-label="Search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
          />
        </div>
      </div>
      {loadError && <LoadError message={loadError} onRetry={load} />}
      {projects === null ? (
        loadError ? null : (
          <Spinner />
        )
      ) : filtered?.length ? (
        <div className="project-list">
          <div className="project-list-heading" aria-hidden="true">
            <span>Project</span>
            <span>Environment</span>
            <span>Status</span>
            <span>Updated</span>
            <span />
          </div>
          {filtered.map((p) => (
            <div className="project-row" key={p.id}>
              <button
                className="project-name"
                aria-label={`Open ${p.name}`}
                onClick={() => onOpen(p.id)}
              >
                <span className="project-icon">
                  <Code2 size={19} />
                </span>
                <span className="project-text">
                  <strong className="truncate" title={p.name}>
                    {p.name}
                  </strong>
                  <small className="truncate" title={p.description || undefined}>
                    {p.description ||
                      (p.ownerId === user.id
                        ? 'Your project'
                        : `Shared by ${p.ownerName || 'a teammate'}`)}
                  </small>
                </span>
              </button>
              <div className="runtime-tags">
                {p.runtimes.map((id) => (
                  <span className="runtime-tag" key={id}>
                    {runtimeCatalog.find((r) => r.id === id)?.name}
                  </span>
                ))}
              </div>
              <Status state={p.running === true ? 'running' : 'idle'} />
              <span className="updated">
                {new Date(p.updatedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              <div className="row-actions">
                {p.role === 'owner' && (
                  <MenuButton label={`Actions for ${p.name}`} icon={<MoreHorizontal size={18} />}>
                    <MenuItem icon={<Pencil size={14} />} onSelect={() => rename(p)}>
                      Rename
                    </MenuItem>
                    <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => destroy(p)}>
                      Delete project
                    </MenuItem>
                  </MenuButton>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-projects">
          <div className="empty-workspace-art" aria-hidden="true">
            <div className="art-toolbar">
              <i />
              <i />
              <i />
            </div>
            <div className="art-body">
              <div className="art-tree">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div className="art-code">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className="art-terminal">
              $ ready to build<span>_</span>
            </div>
          </div>
          <h2>
            {query
              ? 'No matching projects'
              : filter === 'shared'
                ? 'Nothing shared yet'
                : 'Room for your next idea'}
          </h2>
          <p className="muted">
            {query
              ? 'Try a different name.'
              : filter === 'shared'
                ? 'Projects will appear here when someone invites you.'
                : 'Create a project, choose your tools, and make it yours.'}
          </p>
          {!query && filter !== 'shared' && (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
              Create your first project
            </Button>
          )}
        </div>
      )}
      {creating && (
        <CreateProject
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            onOpen(p.id);
          }}
        />
      )}
    </main>
  );
}
function CreateProject({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const [runtimes, setRuntimes] = useState<Runtime[]>(['node']);
  // One source of truth: 'blank', a starter id, 'clone' or 'github'.
  const [source, setSource] = useState('blank');
  const [repo, setRepo] = useState<GitHubRepository | null>(null);
  const [runtimeSuggestion, setRuntimeSuggestion] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const detection = useRef(0);
  const environmentEdits = useRef(0);
  const { busy, run, alive, dispose } = useAsyncAction((e) => {
    if (alive.current) setError(errorMessage(e));
  });
  const starter = starterCatalog.find((s) => s.id === source);
  const github = source === 'github';
  const clone = source === 'clone';
  useEffect(
    () => () => {
      detection.current++;
    },
    [],
  );
  function changeSource(value: string) {
    detection.current++;
    setRepo(null);
    setRuntimeSuggestion('');
    setSource(value);
    const next = starterCatalog.find((s) => s.id === value);
    if (next) setRuntimes([...next.runtimes]);
  }
  const dismiss = () => {
    dispose();
    onClose();
  };
  return (
    <Modal title="Create a project" onClose={dismiss}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (github && !repo) {
            setError('Choose a GitHub repository.');
            return;
          }
          if (!runtimes.length) {
            setError('Choose at least one runtime.');
            return;
          }
          const form = new FormData(e.currentTarget);
          void run(async () => {
            setError('');
            const result = projectCreateSchema.safeParse({
              name: form.get('name'),
              description: form.get('description'),
              runtimes: [...runtimes],
              ...(clone ? { cloneUrl: form.get('cloneUrl') } : {}),
              ...(starter ? { starterId: starter.id } : {}),
              ...(github && repo
                ? { githubSource: { repositoryId: repo.id, installationId: repo.installationId } }
                : {}),
            });
            if (!result.success) {
              setFieldErrors(
                Object.fromEntries(
                  result.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
                ),
              );
              setError('Check the highlighted fields.');
              return;
            }
            setFieldErrors({});
            const created = await post<Project>('/projects', result.data);
            if (alive.current) onCreated(created);
          });
        }}
      >
        <Field id="create-name" label="Project name" error={fieldErrors.name}>
          <input data-autofocus name="name" required maxLength={80} placeholder="my-next-project" />
        </Field>
        <Field id="create-description" label="Description" optional error={fieldErrors.description}>
          <input name="description" maxLength={500} placeholder="What are you building?" />
        </Field>
        <Field
          id="create-source"
          label="Project source"
          help={
            starter
              ? starter.setupCommand
                ? 'Files and dependencies prepare automatically. Click Run when ready.'
                : 'Files prepare automatically. No dependency installation needed. Click Run when ready.'
              : clone
                ? undefined
                : github
                  ? undefined
                  : 'An empty workspace with the runtimes you choose below.'
          }
        >
          <select value={source} onChange={(e) => changeSource(e.target.value)}>
            <optgroup label="Start from">
              <option value="blank">Blank</option>
              {starterCatalog.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Import">
              <option value="clone">Clone repository</option>
              <option value="github">GitHub repository</option>
            </optgroup>
          </select>
        </Field>
        {clone && (
          <Field
            id="create-cloneUrl"
            label="Repository URL"
            error={fieldErrors.cloneUrl}
            help="For private repositories, configure credentials in an empty project’s terminal and clone there."
          >
            <input
              name="cloneUrl"
              maxLength={2048}
              pattern="(https://[^\s]+|git@[a-zA-Z0-9.\-]+:[^\s]+)"
              required
              placeholder="https://github.com/you/repository.git"
            />
          </Field>
        )}
        {github && (
          <div className="source-details">
            <GitHubPicker
              value={repo}
              onSelect={(repo) => {
                setRepo(repo);
                setRuntimeSuggestion('');
                const request = ++detection.current;
                const edits = environmentEdits.current;
                if (repo)
                  api<SetupSuggestion>(
                    `/github/repositories/${repo.id}/suggestion?installationId=${repo.installationId}`,
                  )
                    .then((s) => {
                      if (request !== detection.current) return;
                      if (s.runtimes.length) {
                        if (edits === environmentEdits.current) setRuntimes(s.runtimes);
                        setRuntimeSuggestion(
                          'Detected: ' +
                            s.runtimes.join(', ') +
                            '. Review Run settings after import.',
                        );
                      }
                    })
                    .catch((e) => {
                      if (request === detection.current) setRuntimeSuggestion(errorMessage(e));
                    });
              }}
            />
            {runtimeSuggestion && <p className="field-help">{runtimeSuggestion}</p>}
          </div>
        )}
        <div className="field">
          <div className="field-label">
            <span className="label">Environment</span>
          </div>
          <p className="field-help field-help-top">
            {starter
              ? `Set by the ${starter.name} starter.`
              : 'Combine runtimes. Git and common build tools are always included.'}
          </p>
          <RuntimePicker
            value={runtimes}
            onChange={(value) => {
              environmentEdits.current++;
              setRuntimes(value);
            }}
            disabled={!!starter}
          />
        </div>
        {error && <FormError>{error}</FormError>}
        <div className="modal-actions">
          <Button onClick={dismiss}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} icon={<Plus size={15} />}>
            Create project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
