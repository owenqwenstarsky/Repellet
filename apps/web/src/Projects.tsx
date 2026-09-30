import { useState, useEffect } from 'react';
import type { Project, User, Runtime } from '@repellet/shared';
import { runtimeCatalog } from '@repellet/shared';
import {
  Plus,
  Search,
  ArrowUpRight,
  Code2,
  FolderOpen,
  MoreHorizontal,
  GitBranch,
  Check,
  Box,
  Loader2,
} from 'lucide-react';
import { api, post, patch, remove, errorMessage } from './api';
import { Modal, Status, Spinner, useUi } from './ui';
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
          <span className="runtime-check">{value.includes(r.id) && <Check size={14} />}</span>
        </button>
      ))}
    </div>
  );
}
export function Projects({ user, onOpen }: { user: User; onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const ui = useUi();
  async function load() {
    try {
      setProjects(await api('/projects'));
    } catch (e) {
      ui.notify(errorMessage(e));
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
  return (
    <main className="dashboard">
      <header className="page-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE</div>
          <h1>
            Projects<span className="count">{projects?.length ?? '—'}</span>
          </h1>
          <p className="muted">Pick up where you left off, or start something new.</p>
        </div>
        <button className="button primary" onClick={() => setCreating(true)}>
          <Plus size={17} /> Create project
        </button>
      </header>
      <div className="project-toolbar">
        <div className="segment">
          {[
            ['all', 'All projects'],
            ['mine', 'Owned by me'],
            ['shared', 'Shared with me'],
          ].map(([id, label]) => (
            <button
              key={id}
              className={filter === id ? 'active' : ''}
              onClick={() => setFilter(id!)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
          />
        </div>
      </div>
      {projects === null ? (
        <Spinner />
      ) : filtered?.length ? (
        <div className="project-list">
          <div className="project-list-heading">
            <span>PROJECT</span>
            <span>ENVIRONMENT</span>
            <span>STATUS</span>
            <span>LAST UPDATED</span>
            <span />
          </div>
          {filtered.map((p) => (
            <div className="project-row" key={p.id}>
              <button className="project-name" onClick={() => onOpen(p.id)}>
                <div className="project-icon">
                  <Code2 size={23} />
                </div>
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.description ||
                      `${p.ownerId === user.id ? 'Your project' : `Shared by ${p.ownerName || 'a teammate'}`}`}
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
              <Status state={p.state} />
              <span className="updated">
                {new Date(p.updatedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              <div className="row-actions">
                <button
                  className="icon-button"
                  title="Open workspace"
                  aria-label={`Open ${p.name}`}
                  onClick={() => onOpen(p.id)}
                >
                  <ArrowUpRight size={18} />
                </button>
                <button
                  className="icon-button"
                  aria-label={`Actions for ${p.name}`}
                  onClick={() => setMenu(menu === p.id ? null : p.id)}
                >
                  <MoreHorizontal size={19} />
                </button>
                {menu === p.id && (
                  <>
                    <div className="menu-dismiss" onClick={() => setMenu(null)} />
                    <div className="dropdown">
                      <button
                        onClick={() => {
                          setMenu(null);
                          onOpen(p.id);
                        }}
                      >
                        Open workspace
                      </button>
                      {p.role === 'owner' && (
                        <>
                          <button
                            onClick={async () => {
                              setMenu(null);
                              const name = await ui.ask({
                                title: 'Rename project',
                                value: p.name,
                                label: 'Project name',
                              });
                              if (name)
                                try {
                                  await patch(`/projects/${p.id}`, { name });
                                  await load();
                                } catch (e) {
                                  ui.notify(errorMessage(e));
                                }
                            }}
                          >
                            Rename
                          </button>
                          <button
                            className="danger-text"
                            onClick={async () => {
                              setMenu(null);
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
                            }}
                          >
                            Delete project
                          </button>
                        </>
                      )}
                    </div>
                  </>
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
            <button className="button primary" onClick={() => setCreating(true)}>
              <Plus size={17} /> Create your first project
            </button>
          )}
        </div>
      )}
      <footer className="dashboard-footer">
        <span>
          <Box size={14} /> Containers run on your server
        </span>
        <span>
          {projects?.filter((p) => p.state === 'running').length || 0} running · Projects are
          private by default
        </span>
      </footer>
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
  const [clone, setClone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title="Create a project" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!runtimes.length) {
            setError('Choose at least one runtime.');
            return;
          }
          setBusy(true);
          setError('');
          const form = new FormData(e.currentTarget);
          try {
            onCreated(
              await post('/projects', {
                name: form.get('name'),
                description: form.get('description'),
                runtimes,
                ...(clone ? { cloneUrl: form.get('cloneUrl') } : {}),
              }),
            );
          } catch (e) {
            setError(errorMessage(e));
            setBusy(false);
          }
        }}
      >
        <label>
          Project name
          <input autoFocus name="name" required maxLength={80} placeholder="my-next-project" />
        </label>
        <label>
          Description <span className="optional">optional</span>
          <input name="description" maxLength={500} placeholder="What are you building?" />
        </label>
        <div className="label">Environment</div>
        <p className="field-help">
          Combine runtimes. Git and common build tools are always included.
        </p>
        <RuntimePicker value={runtimes} onChange={setRuntimes} />
        <button type="button" className="text-button clone-toggle" onClick={() => setClone(!clone)}>
          <GitBranch size={16} />
          {clone ? 'Start with an empty project' : 'Clone a Git repository'}
        </button>
        {clone && (
          <label>
            Repository URL
            <input name="cloneUrl" required placeholder="https://github.com/you/repository.git" />
            <span className="field-help">
              For private repositories, configure credentials in an empty project’s terminal and
              clone there.
            </span>
          </label>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}
