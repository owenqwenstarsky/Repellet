import { useState, useEffect, useRef, lazy, Suspense, type ReactNode } from 'react';
import type { Project, User, TerminalInfo, FileContent } from '@repellet/shared';
import {
  ArrowLeft,
  Play,
  Square,
  Settings,
  ExternalLink,
  RefreshCw,
  Plus,
  X,
  Files,
  Search,
  GitBranch,
  PanelRight,
  TerminalSquare,
  ChevronRight,
  Code2,
  Box,
  AlertTriangle,
  Loader2,
  Users,
} from 'lucide-react';
import { api, post, errorMessage, previewUrl, wsUrl, formatBytes } from './api';
import { Logo, Avatar, Status, Spinner, useUi } from './ui';
import { FileTree, FileIcon, SearchPane } from './Files';
import { GitPane } from './GitPane';
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
import { Terminal } from './Terminal';
import { ProjectSettings } from './Settings';
export function Workspace({
  id,
  user,
  onBack,
  onOpen,
}: {
  id: string;
  user: User;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [pane, setPane] = useState('files');
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [selection, setSelection] = useState<{ line: number; column: number }>();
  const [revision, setRevision] = useState(0);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [terminal, setTerminal] = useState('');
  const [peers, setPeers] = useState<{ id: string; name: string }[]>([]);
  const [settings, setSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [showTerminal, setShowTerminal] = useState(true);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [status, setStatus] = useState('Ready');
  const [buildLog, setBuildLog] = useState('');
  const [leftWidth, setLeftWidth] = useState(232);
  const [previewWidth, setPreviewWidth] = useState(420);
  const [terminalHeight, setTerminalHeight] = useState(230);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const initializedTerminal = useRef(false);
  const mounted = useRef(true);
  const ui = useUi();
  const editable = project?.role !== 'viewer';
  const base = `/projects/${id}`;
  async function load() {
    try {
      const p = await api<Project>(base);
      if (!mounted.current) return;
      setProject(p);
      if (p.state === 'building' || p.state === 'starting') {
        const log = await api<{ log: string }>(base + '/build-log');
        if (mounted.current) setBuildLog(log.log);
      }
    } catch (e) {
      if (mounted.current) {
        setLoadError(errorMessage(e));
      }
    }
  }
  async function loadTerminals() {
    try {
      const list = await api<TerminalInfo[]>(base + '/terminals');
      if (!mounted.current) return;
      setTerminals(list);
      setTerminal((previous) =>
        list.some((t) => t.id === previous)
          ? previous
          : list.find((t) => t.isRun && t.alive)?.id || list[0]?.id || '',
      );
      if (!list.length && editable && !initializedTerminal.current) {
        initializedTerminal.current = true;
        const created = await post<TerminalInfo>(base + '/terminals', { name: 'Terminal 1' });
        if (mounted.current) {
          setTerminals([created]);
          setTerminal(created.id);
        }
      }
    } catch {}
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    void post(base + '/open').catch((e) => ui.notify(errorMessage(e)));
    const timer = setInterval(load, 2000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [id]);
  useEffect(() => {
    if (project?.state !== 'running') return;
    void loadTerminals();
    const timer = setInterval(loadTerminals, 2500);
    let socket: WebSocket | null = null,
      reconnect: ReturnType<typeof setTimeout> | undefined,
      disposed = false;
    function connect() {
      if (disposed) return;
      socket = new WebSocket(wsUrl(`/ws/projects/${id}/events`));
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'presence') setPeers(message.peers);
          if (message.type === 'file' || message.type === 'files') setRevision((v) => v + 1);
          if (message.type === 'terminals') void loadTerminals();
          if (message.type === 'state') void load();
          if (message.type === 'structure') {
            setRevision((v) => v + 1);
            const from = message.from,
              to = message.to;
            const mapped = (path: string) =>
              path === from || path.startsWith(from + '/')
                ? to
                  ? to + path.slice(from.length)
                  : null
                : path;
            setTabs((v) => v.map(mapped).filter((p): p is string => !!p));
            setActive((v) => mapped(v) || '');
          }
          if (message.type === 'storage')
            setProject((p) =>
              p ? { ...p, storageBytes: message.bytes, storageExceeded: message.exceeded } : p,
            );
          if (message.type === 'error') ui.notify(message.message);
        } catch {}
      };
      socket.onclose = (e) => {
        if (disposed) return;
        if (e.code === 1008) {
          void load();
          ui.notify(e.reason || 'Project access changed.');
          return;
        }
        reconnect = setTimeout(connect, 2000);
      };
    }
    connect();
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(reconnect);
      socket?.close();
    };
  }, [id, project?.state, project?.role]);
  async function openFile(path: string, line = 1, column = 1) {
    try {
      const file = await api<FileContent>(base + `/file?path=${encodeURIComponent(path)}`);
      if (file.binary) {
        ui.notify('This file is binary or larger than 2 MiB. Use Download from its file menu.');
        return;
      }
      setTabs((v) => (v.includes(path) ? v : [...v, path]));
      setActive(path);
      setSelection({ line, column });
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  function closeTab(path: string) {
    setTabs((v) => v.filter((t) => t !== path));
    if (active === path) setActive(tabs.filter((t) => t !== path).at(-1) || '');
  }
  async function run() {
    if (!project?.runConfig.command.trim()) {
      if (project?.role === 'owner') setSettings(true);
      else ui.notify('The project owner needs to set a run command.');
      return;
    }
    setBusy(true);
    try {
      await post(base + '/run');
      setShowTerminal(true);
      setTerminal('run');
      await loadTerminals();
      setTerminal('run');
      setPreviewRevision((v) => v + 1);
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && editable) {
        e.preventDefault();
        void run();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        setStatus('Autosave enabled');
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setPane('search');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [project, editable]);
  if (loadError)
    return (
      <div className="workspace-load-error">
        <AlertTriangle size={30} />
        <h2>Workspace unavailable</h2>
        <p>{loadError}</p>
        <button className="button secondary" onClick={onBack}>
          <ArrowLeft size={16} />
          Back to projects
        </button>
      </div>
    );
  if (!project) return <Spinner label="Opening workspace…" />;
  const ready = project.state === 'running';
  const running = terminals.some((t) => t.isRun && t.alive);
  const url = project.previewPort ? previewUrl(project.previewPort) : '';
  return (
    <div className="workspace">
      <header className="workspace-header">
        <button
          className="icon-button"
          title="Back to projects"
          aria-label="Back to projects"
          onClick={onBack}
        >
          <ArrowLeft size={18} />
        </button>
        <Logo compact />
        <ChevronRight size={14} className="muted" />
        <strong className="workspace-title">{project.name}</strong>
        <Status state={project.state} />
        <div className="workspace-header-spacer" />
        <div className="collaborators" title="People in this workspace">
          {peers.slice(0, 4).map((p) => (
            <Avatar key={p.id} name={p.name} size={25} />
          ))}
          {peers.length > 4 && <span>+{peers.length - 4}</span>}
        </div>
        {project.role === 'viewer' && <span className="role-label">View only</span>}
        <button
          className="icon-button"
          title="Project settings and people"
          aria-label="Project settings"
          onClick={() => setSettings(true)}
        >
          <Settings size={17} />
        </button>
        <div className="toolbar-divider" />
        {editable && (
          <>
            <button
              className="icon-button"
              disabled={!ready || busy}
              title="Stop app"
              aria-label="Stop app"
              onClick={async () => {
                try {
                  await post(base + '/run/stop');
                  await loadTerminals();
                } catch (e) {
                  ui.notify(errorMessage(e));
                }
              }}
            >
              <Square size={14} fill={running ? 'currentColor' : 'none'} />
            </button>
            <button
              aria-label="Run"
              className="button primary run-button"
              disabled={!ready || busy || project.storageExceeded}
              onClick={run}
            >
              {busy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Play size={13} fill="currentColor" />
              )}
              {running ? 'Restart' : 'Run'}
              <kbd>⌘ ↵</kbd>
            </button>
          </>
        )}
      </header>
      {project.storageExceeded && (
        <div className="storage-banner">
          <AlertTriangle size={15} />
          Storage limit reached. Execution is suspended. Delete files to free space or ask the site
          owner to increase the limit.
        </div>
      )}
      {!ready ? (
        <div className="workspace-preparing">
          <Box size={38} />
          <h2>
            {project.state === 'failed'
              ? 'The workspace needs attention'
              : project.state === 'stopped'
                ? 'Workspace is stopped'
                : 'Preparing your environment'}
          </h2>
          <p className="muted">
            {project.error || `${project.runtimes.join(' + ')} · Your files stay on your server`}
          </p>
          {['building', 'starting', 'stopping'].includes(project.state) ? (
            <Spinner
              label={
                project.state === 'building'
                  ? 'Installing and checking your tools…'
                  : 'Updating workspace…'
              }
            />
          ) : (
            <button
              className="button primary"
              onClick={() =>
                post(base + '/open')
                  .then(() => load())
                  .catch((e) => ui.notify(errorMessage(e)))
              }
            >
              <Play size={15} />
              Start workspace
            </button>
          )}
          {buildLog && (
            <details open={project.state === 'failed'}>
              <summary>Environment build log</summary>
              <pre>{buildLog}</pre>
            </details>
          )}
        </div>
      ) : (
        <>
          <div className="workspace-body">
            <nav className="activity-bar" aria-label="Workspace tools">
              {[
                ['files', 'Files', Files],
                ['search', 'Search', Search],
                ['git', 'Source control', GitBranch],
              ].map(([name, label, Icon]) => (
                <button
                  key={name as string}
                  className={pane === name ? 'active' : ''}
                  aria-label={label as string}
                  title={label as string}
                  onClick={() => setPane(name as string)}
                >
                  {typeof Icon !== 'string' && <Icon size={20} />}
                </button>
              ))}
              <div className="activity-spacer" />
              <button
                aria-label="Toggle terminal"
                title="Toggle terminal"
                className={showTerminal ? 'active-subtle' : ''}
                onClick={() => setShowTerminal(!showTerminal)}
              >
                <TerminalSquare size={20} />
              </button>
              <button
                aria-label="Toggle preview"
                title="Toggle preview"
                className={showPreview ? 'active-subtle' : ''}
                onClick={() => setShowPreview(!showPreview)}
              >
                <PanelRight size={20} />
              </button>
            </nav>
            <aside className="explorer" style={{ width: leftWidth }}>
              {pane === 'files' ? (
                <FileTree
                  projectId={id}
                  active={active}
                  onOpen={openFile}
                  editable={editable}
                  revision={revision}
                />
              ) : pane === 'search' ? (
                <SearchPane projectId={id} editable={editable} onOpen={openFile} />
              ) : (
                <GitPane projectId={id} editable={editable} revision={revision} />
              )}
            </aside>
            <ResizeHandle
              onDelta={(delta) => setLeftWidth((v) => Math.max(170, Math.min(480, v + delta)))}
            />
            <section className="workspace-center">
              <div className="workspace-upper">
                <section className="editor-stack">
                  <div className="editor-tabs">
                    {tabs.map((path) => (
                      <div className={`editor-tab ${active === path ? 'active' : ''}`} key={path}>
                        <button
                          onClick={() => {
                            setActive(path);
                            setSelection(undefined);
                          }}
                        >
                          <FileIcon name={path} />
                          <span title={path}>{path.split('/').pop()}</span>
                        </button>
                        <button
                          aria-label={`Close ${path}`}
                          className="tab-close"
                          onClick={() => closeTab(path)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {active ? (
                    <>
                      <div className="breadcrumbs">
                        {active.split('/').map((part, i) => (
                          <span key={i}>
                            {i > 0 && <ChevronRight size={12} />} {part}
                          </span>
                        ))}
                      </div>
                      <Suspense fallback={<Spinner label="Opening editor…" />}>
                        <CodeEditor
                          key={active}
                          projectId={id}
                          path={active}
                          user={user}
                          editable={editable}
                          onStatus={setStatus}
                          onDefinition={openFile}
                          selection={selection}
                        />
                      </Suspense>
                    </>
                  ) : (
                    <div className="editor-welcome">
                      <div className="welcome-mark">
                        <Code2 size={44} strokeWidth={1} />
                      </div>
                      <h2>{project.name}</h2>
                      <p>Open a file to start working.</p>
                      <div className="shortcut-list">
                        <span>
                          Run project<kbd>⌘ Enter</kbd>
                        </span>
                        <span>
                          Search files<kbd>⌘ Shift F</kbd>
                        </span>
                        <span>
                          Command palette<kbd>F1</kbd>
                        </span>
                      </div>
                      <small>Changes save automatically.</small>
                    </div>
                  )}
                </section>
                {showPreview && (
                  <>
                    <ResizeHandle
                      onDelta={(delta) =>
                        setPreviewWidth((v) => Math.max(260, Math.min(720, v - delta)))
                      }
                    />
                    <aside className="preview-pane" style={{ width: previewWidth }}>
                      <div className="panel-heading">
                        <span>Preview</span>
                        <div>
                          <button
                            className="icon-button"
                            aria-label="Refresh preview"
                            onClick={() => setPreviewRevision((v) => v + 1)}
                          >
                            <RefreshCw size={14} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="Open preview in new tab"
                            onClick={() => window.open(url, '_blank', 'noopener')}
                            disabled={!url}
                          >
                            <ExternalLink size={14} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="Close preview"
                            onClick={() => setShowPreview(false)}
                          >
                            <X size={15} />
                          </button>
                        </div>
                      </div>
                      <div className="preview-url">
                        <span className="online-dot" />
                        <input aria-label="Preview URL" readOnly value={url} />
                      </div>
                      {url ? (
                        <iframe
                          key={previewRevision}
                          src={url}
                          title="Project preview"
                          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
                        />
                      ) : (
                        <div className="pane-empty">No preview port available.</div>
                      )}
                    </aside>
                  </>
                )}
              </div>
              {showTerminal && (
                <>
                  <ResizeHandle
                    horizontal
                    onDelta={(delta) =>
                      setTerminalHeight((v) => Math.max(100, Math.min(550, v - delta)))
                    }
                  />
                  <section className="terminal-panel" style={{ height: terminalHeight }}>
                    <div className="terminal-tabs">
                      <span className="terminal-label">TERMINAL</span>
                      {terminals.map((t) => (
                        <button
                          key={t.id}
                          className={terminal === t.id ? 'active' : ''}
                          onClick={() => setTerminal(t.id)}
                        >
                          <span className={`terminal-dot ${t.alive ? 'alive' : ''}`} />
                          {t.name}
                          {editable && !t.isRun && (
                            <span
                              className="terminal-close"
                              role="button"
                              aria-label={`Stop ${t.name}`}
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await removeTerminal(t.id);
                                  await loadTerminals();
                                } catch (error) {
                                  ui.notify(errorMessage(error));
                                }
                              }}
                            >
                              <X size={11} />
                            </span>
                          )}
                        </button>
                      ))}
                      <div className="terminal-spacer" />
                      {editable && (
                        <button
                          className="icon-button"
                          aria-label="New terminal"
                          onClick={async () => {
                            try {
                              const name = await ui.ask({
                                title: 'New terminal',
                                label: 'Terminal name',
                                value: `Terminal ${terminals.filter((t) => !t.isRun).length + 1}`,
                              });
                              if (!name) return;
                              const created = await post<TerminalInfo>(base + '/terminals', {
                                name,
                              });
                              await loadTerminals();
                              setTerminal(created.id);
                            } catch (e) {
                              ui.notify(errorMessage(e));
                            }
                          }}
                        >
                          <Plus size={15} />
                        </button>
                      )}
                      <button
                        className="icon-button"
                        aria-label="Hide terminal"
                        onClick={() => setShowTerminal(false)}
                      >
                        <X size={15} />
                      </button>
                    </div>
                    {terminal ? (
                      <Terminal key={terminal} projectId={id} id={terminal} editable={editable} />
                    ) : (
                      <div className="terminal-empty">
                        {editable
                          ? 'Create a terminal with + to get started.'
                          : 'No terminal sessions are running.'}
                      </div>
                    )}
                  </section>
                </>
              )}
            </section>
          </div>
          <footer className="workspace-status">
            <span>
              <span className="online-dot" />
              {status}
            </span>
            <span className="status-right">
              <span>
                {project.runtimes
                  .map((r) => (r === 'node' ? 'Node.js' : r.charAt(0).toUpperCase() + r.slice(1)))
                  .join(' + ')}
              </span>
              <span>{formatBytes(project.storageBytes)}</span>
              <button
                onClick={async () => {
                  if (!editable) return;
                  if (
                    await ui.ask({
                      title: 'Stop workspace?',
                      description: 'This stops terminals and running apps. Files are kept.',
                      confirm: true,
                    })
                  )
                    try {
                      await post(base + '/stop');
                      await load();
                    } catch (e) {
                      ui.notify(errorMessage(e));
                    }
                }}
                disabled={!editable}
              >
                <Square size={11} />
                Stop workspace
              </button>
            </span>
          </footer>
        </>
      )}
      {settings && (
        <ProjectSettings
          project={project}
          onClose={() => setSettings(false)}
          onChanged={load}
          onDuplicate={(id) => {
            setSettings(false);
            onOpen(id);
          }}
        />
      )}
    </div>
  );
  async function removeTerminal(terminalId: string) {
    return api(base + '/terminals/' + terminalId, { method: 'DELETE' });
  }
}
function ResizeHandle({
  horizontal = false,
  onDelta,
}: {
  horizontal?: boolean;
  onDelta: (delta: number) => void;
}) {
  return (
    <div
      className={`resize-handle ${horizontal ? 'horizontal' : ''}`}
      role="separator"
      aria-label={horizontal ? 'Resize terminal' : 'Resize panel'}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      tabIndex={0}
      onKeyDown={(e) => {
        if (['ArrowLeft', 'ArrowUp'].includes(e.key)) onDelta(-10);
        if (['ArrowRight', 'ArrowDown'].includes(e.key)) onDelta(10);
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        let previous = horizontal ? e.clientY : e.clientX;
        const move = (event: PointerEvent) => {
          const current = horizontal ? event.clientY : event.clientX;
          onDelta(current - previous);
          previous = current;
        };
        const end = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
          document.body.classList.remove('resizing');
        };
        document.body.classList.add('resizing');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end, { once: true });
      }}
    />
  );
}
