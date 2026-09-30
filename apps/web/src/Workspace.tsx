import { useState, useEffect, useRef, lazy, Suspense, type ReactNode } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type {
  Project,
  User,
  TerminalInfo,
  FileContent,
  PreparationJob,
  FileIndex,
  WorkspacePreferences,
} from '@repellet/shared';
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
import { Logo, Avatar, Status, Spinner, useUi, hasOpenDialog, LoadError } from './ui';
import { FileTree, FileIcon, SearchPane } from './Files';
import { GitPane } from './GitPane';
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
import { Terminal } from './Terminal';
import { preferenceKey, readPreferences, savePreferences } from './preferences';
import { flushOpenDocuments } from './documentSaves';
import { QuickOpen } from './QuickOpen';
const Problems = lazy(() => import('./Problems').then((m) => ({ default: m.Problems })));
import { ProjectSettings } from './Settings';
import { panelDimensions, remapPath, runEligible, type StructureChange } from './workspaceState';
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
  const preferencesKey = preferenceKey(user.id, id);
  const [saved] = useState(() => readPreferences(preferencesKey));
  const restored = useRef(false);
  const loadVersion = useRef(0);
  const positions = useRef(saved.positions);
  const snapshot = useRef<WorkspacePreferences>(saved);
  const [quickOpen, setQuickOpen] = useState(false);
  const [showSidebar, setShowSidebar] = useState(saved.showSidebar);
  const [project, setProject] = useState<Project | null>(null);
  const [pane, setPane] = useState(saved.pane);
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [selection, setSelection] = useState<{ line: number; column: number }>();
  const [indexRevision, setIndexRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [terminal, setTerminal] = useState(saved.terminal);
  const [peers, setPeers] = useState<{ id: string; name: string }[]>([]);
  const [settings, setSettings] = useState(false);
  const [showPreview, setShowPreview] = useState(saved.showPreview);
  const [showTerminal, setShowTerminal] = useState(saved.showTerminal);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [status, setStatus] = useState('Ready');
  const [preparationLog, setPreparationLog] = useState('');
  const [languageStatus, setLanguageStatus] = useState('');
  const viewStates = useRef(new Map<string, MonacoEditor.ICodeEditorViewState>());
  const [buildLog, setBuildLog] = useState('');
  const [leftWidth, setLeftWidth] = useState(saved.leftWidth);
  const [previewWidth, setPreviewWidth] = useState(saved.previewWidth);
  const [terminalHeight, setTerminalHeight] = useState(saved.terminalHeight);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [logError, setLogError] = useState('');
  const [terminalError, setTerminalError] = useState('');
  const [structure, setStructure] = useState<StructureChange[]>([]);
  const [visited, setVisited] = useState(new Set(['files', saved.pane]));
  const bodyRef = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ width: window.innerWidth, height: window.innerHeight - 78 });
  const fileIntent = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const initializedTerminal = useRef(false);
  const terminalLoading = useRef(false);
  const runPending = useRef(false);
  const pollPending = useRef(false);
  const mounted = useRef(true);
  const ui = useUi();
  const editable = !!project && project.role !== 'viewer';
  const latestProject = useRef(project);
  latestProject.current = project;
  const canRun =
    editable &&
    project.state === 'running' &&
    !project.storageExceeded &&
    ['none', 'ready'].includes(project.preparation.status) &&
    !busy;
  const base = `/projects/${id}`;
  async function load() {
    if (pollPending.current) return;
    pollPending.current = true;
    const request = ++loadVersion.current;
    try {
      const p = await api<Project>(base);
      if (!mounted.current || request !== loadVersion.current) return;
      setProject(p);
      setLoadError('');
      if (p.preparation.status !== 'none') {
        const progress = await api<{ jobs: PreparationJob[] }>(base + '/preparation');
        if (mounted.current && request === loadVersion.current)
          setPreparationLog(progress.jobs.find((j) => j.step)?.log || '');
      }
      if (p.state === 'building' || p.state === 'starting') {
        try {
          const log = await api<{ log: string }>(base + '/build-log');
          if (mounted.current) {
            setBuildLog(log.log);
            setLogError('');
          }
        } catch (e) {
          if (mounted.current) setLogError(errorMessage(e));
        }
      }
    } catch (e) {
      if (mounted.current && request === loadVersion.current) {
        setLoadError(errorMessage(e));
      }
    } finally {
      pollPending.current = false;
    }
  }
  async function loadTerminals() {
    if (terminalLoading.current) return;
    terminalLoading.current = true;
    try {
      const list = await api<TerminalInfo[]>(base + '/terminals');
      if (!mounted.current) return;
      setTerminals(list);
      setTerminalError('');
      setTerminal((previous) =>
        list.some((t) => t.id === previous)
          ? previous
          : list.find((t) => t.isRun && t.alive)?.id || list[0]?.id || '',
      );
      if (!list.length && editable && !initializedTerminal.current) {
        const created = await post<TerminalInfo>(base + '/terminals', { name: 'Terminal 1' });
        initializedTerminal.current = true;
        if (mounted.current) {
          setTerminals([created]);
          setTerminal(created.id);
        }
      }
    } catch (e) {
      if (mounted.current) setTerminalError(errorMessage(e));
    } finally {
      terminalLoading.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    void post(base + '/open').catch((e) => ui.notify(errorMessage(e)));
    const timer = setInterval(load, 2000);
    return () => {
      mounted.current = false;
      loadVersion.current++;
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
          if (
            message.type === 'files' ||
            (message.type === 'file' &&
              ['add', 'addDir', 'unlink', 'unlinkDir'].includes(message.event))
          )
            setIndexRevision((v) => v + 1);
          if (message.type === 'file' && ['unlink', 'unlinkDir'].includes(message.event))
            setTabs((v) =>
              v.filter((path) => path !== message.path && !path.startsWith(message.path + '/')),
            );
          if (message.type === 'terminals') void loadTerminals();
          if (message.type === 'state') void load();
          if (message.type === 'structure') {
            setIndexRevision((v) => v + 1);
            setRevision((v) => v + 1);
            const change = { from: message.from, to: message.to };
            fileIntent.current++;
            setStructure((changes) => [...changes, change]);
            const remaining = tabsRef.current
              .map((path) => remapPath(path, change))
              .filter((p): p is string => !!p);
            tabsRef.current = remaining;
            setTabs(remaining);
            setActive((v) => remapPath(v, change) || remaining.at(-1) || '');
            positions.current = Object.fromEntries(
              Object.entries(positions.current).flatMap(([path, pos]) => {
                const next = remapPath(path, change);
                return next ? [[next, pos]] : [];
              }),
            );
            viewStates.current = new Map(
              [...viewStates.current].flatMap(([path, state]) => {
                const next = remapPath(path, change);
                return next ? [[next, state]] : [];
              }),
            );
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
  useEffect(() => {
    if (project?.state !== 'running' || restored.current) return;
    let disposed = false;
    const version = fileIntent.current;
    void (async () => {
      const candidates = saved.tabs.length
        ? saved.tabs
        : project.starterId === 'react-vite'
          ? ['src/App.tsx']
          : project.starterId === 'python-fastapi'
            ? ['main.py']
            : [];
      const existing: string[] = [];
      for (const path of candidates) {
        try {
          const file = await api<FileContent>(base + '/file?path=' + encodeURIComponent(path));
          if (!file.binary && file.hash) existing.push(path);
        } catch {}
      }
      if (disposed || restored.current || version !== fileIntent.current) return;
      // Starter files may not have been scaffolded yet; try again after preparation changes.
      if (
        !existing.length &&
        project.starterId &&
        ['pending', 'files'].includes(project.preparation.status)
      )
        return;
      tabsRef.current = existing;
      setTabs(existing);
      setActive(existing.includes(saved.active) ? saved.active : existing[0] || '');
      restored.current = true;
    })().catch((e) => ui.notify(errorMessage(e)));
    return () => {
      disposed = true;
    };
  }, [project?.state, project?.preparation.status]);
  useEffect(() => {
    snapshot.current = {
      version: 1,
      tabs,
      active,
      positions: positions.current,
      pane,
      showSidebar,
      showPreview,
      showTerminal,
      leftWidth,
      previewWidth,
      terminalHeight,
      terminal,
    };
    if (restored.current) savePreferences(preferencesKey, snapshot.current);
  }, [
    tabs,
    active,
    pane,
    showSidebar,
    showPreview,
    showTerminal,
    leftWidth,
    previewWidth,
    terminalHeight,
    terminal,
  ]);
  useEffect(() => {
    const clamp = () => {
      setLeftWidth((v) => Math.min(v, Math.max(150, innerWidth * 0.35)));
      setPreviewWidth((v) => Math.min(v, Math.max(200, innerWidth * 0.45)));
      setTerminalHeight((v) => Math.min(v, Math.max(100, innerHeight * 0.6)));
    };
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);
  useEffect(() => {
    if (restored.current && !tabs.includes(active)) setActive(tabs.at(-1) || '');
  }, [tabs, active]);
  async function openFile(path: string, line?: number, column = 1) {
    const intent = ++fileIntent.current;
    try {
      const file = await api<FileContent>(base + `/file?path=${encodeURIComponent(path)}`);
      if (!mounted.current || intent !== fileIntent.current) return;
      if (file.binary) {
        ui.notify('This file is binary or larger than 2 MiB. Use Download from its file menu.');
        return;
      }
      restored.current = true;
      const nextTabs = tabsRef.current.includes(path)
        ? tabsRef.current
        : [...tabsRef.current, path];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActive(path);
      setSelection(line === undefined ? undefined : { line, column });
    } catch (e) {
      if (mounted.current && intent === fileIntent.current) ui.notify(errorMessage(e));
    }
  }
  async function closeTab(path: string) {
    fileIntent.current++;
    try {
      await flushOpenDocuments(id);
    } catch (e) {
      ui.notify(errorMessage(e));
      return;
    }
    if (!mounted.current) return;
    delete positions.current[path];
    const remaining = tabsRef.current.filter((t) => t !== path);
    tabsRef.current = remaining;
    setTabs(remaining);
    setActive((current) => (current === path ? remaining.at(-1) || '' : current));
    viewStates.current.delete(path);
  }
  async function run() {
    if (!canRun || !runEligible(project, busy || runPending.current, hasOpenDialog())) return;
    if (!project?.runConfig.command.trim()) {
      if (project?.role === 'owner') setSettings(true);
      else ui.notify('The project owner needs to set a run command.');
      return;
    }
    runPending.current = true;
    setBusy(true);
    try {
      await flushOpenDocuments(id);
      const current = latestProject.current;
      if (
        !mounted.current ||
        !current ||
        current.role === 'viewer' ||
        current.state !== 'running' ||
        current.storageExceeded ||
        !['none', 'ready'].includes(current.preparation.status)
      )
        return;
      await post(base + '/run');
      setShowTerminal(true);
      setTerminal('run');
      await loadTerminals();
      setTerminal('run');
      setPreviewRevision((v) => v + 1);
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      runPending.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || hasOpenDialog()) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuickOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && editable) {
        e.preventDefault();
        void run();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setPane('search');
        setShowSidebar(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [project, editable, busy]);
  useEffect(() => {
    setVisited((old) => new Set([...old, pane]));
  }, [pane]);
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const measure = () => setSpace({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [project?.state]);
  const dimensions = panelDimensions(
    space.width,
    space.height,
    { explorer: leftWidth, preview: previewWidth, terminal: terminalHeight },
    showPreview,
    showTerminal,
  );
  if (loadError && !project)
    return (
      <div className="workspace-load-error">
        <AlertTriangle size={30} />
        <h2>Workspace unavailable</h2>
        <p>{loadError}</p>
        <button className="button primary" onClick={load}>
          Retry
        </button>
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
      {quickOpen && (
        <QuickOpen
          projectId={id}
          revision={indexRevision}
          onOpen={openFile}
          onClose={() => setQuickOpen(false)}
        />
      )}
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
        <strong className="workspace-title" title={project.name}>
          {project.name}
        </strong>
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
              disabled={!canRun}
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
      {loadError && <LoadError message={`Workspace update failed: ${loadError}`} onRetry={load} />}
      {project.storageExceeded && (
        <div className="storage-banner">
          <AlertTriangle size={15} />
          Storage limit reached. Execution is suspended. Delete files to free space or ask the site
          owner to increase the limit.
        </div>
      )}
      {ready && project.preparation.status !== 'none' && (
        <div className="preparation-banner" role="status">
          <span>
            {
              {
                pending: 'Preparing files',
                files: 'Preparing files',
                installing: 'Installing dependencies',
                ready: 'Ready to run',
                failed: 'Preparation failed',
                interrupted: 'Preparation interrupted',
              }[project.preparation.status]
            }
          </span>
          {project.preparation.error && <span>{project.preparation.error}</span>}
          {editable && ['failed', 'interrupted'].includes(project.preparation.status) && (
            <button
              className="button secondary"
              onClick={() => post(base + '/prepare').catch((e) => ui.notify(errorMessage(e)))}
            >
              Retry preparation
            </button>
          )}
          {preparationLog && (
            <details>
              <summary>Preparation log</summary>
              <pre>{preparationLog}</pre>
            </details>
          )}
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
          {logError && <LoadError message={`Build log unavailable: ${logError}`} onRetry={load} />}
          {buildLog && (
            <details open={project.state === 'failed'}>
              <summary>Environment build log</summary>
              <pre>{buildLog}</pre>
            </details>
          )}
        </div>
      ) : (
        <>
          <div className="workspace-body" ref={bodyRef}>
            <nav className="activity-bar" aria-label="Workspace tools">
              {[
                ['files', 'Files', Files],
                ['search', 'Search', Search],
                ['git', 'Source control', GitBranch],
                ['problems', 'Open files', AlertTriangle],
              ].map(([name, label, Icon]) => (
                <button
                  key={name as string}
                  className={pane === name ? 'active' : ''}
                  aria-pressed={pane === name}
                  aria-label={label as string}
                  title={label as string}
                  onClick={() => {
                    setPane(name as string);
                    setShowSidebar(true);
                  }}
                >
                  {typeof Icon !== 'string' && <Icon size={20} />}
                </button>
              ))}
              <button aria-label="Toggle sidebar" onClick={() => setShowSidebar((v) => !v)}>
                <Files size={18} />
              </button>
              <div className="activity-spacer" />
              <button
                aria-pressed={showTerminal}
                aria-label="Toggle terminal"
                title="Toggle terminal"
                className={showTerminal ? 'active-subtle' : ''}
                onClick={() => setShowTerminal(!showTerminal)}
              >
                <TerminalSquare size={20} />
              </button>
              <button
                aria-pressed={showPreview}
                aria-label="Toggle preview"
                title="Toggle preview"
                className={showPreview ? 'active-subtle' : ''}
                onClick={() => setShowPreview(!showPreview)}
              >
                <PanelRight size={20} />
              </button>
            </nav>
            <aside
              className="explorer"
              style={{
                width: showSidebar ? dimensions.explorer : 0,
                display: showSidebar ? undefined : 'none',
              }}
            >
              <div className="tool-pane" hidden={pane !== 'files'}>
                <FileTree
                  projectId={id}
                  active={active}
                  onOpen={openFile}
                  editable={editable}
                  revision={revision}
                  visible={pane === 'files'}
                  structure={structure}
                />
              </div>
              {visited.has('search') && (
                <div className="tool-pane" hidden={pane !== 'search'}>
                  <SearchPane
                    projectId={id}
                    editable={editable}
                    onOpen={openFile}
                    visible={pane === 'search'}
                  />
                </div>
              )}
              {visited.has('problems') && (
                <div className="tool-pane" hidden={pane !== 'problems'}>
                  <Suspense fallback={<Spinner />}>
                    <Problems projectId={id} tabs={tabs} onOpen={openFile} />
                  </Suspense>
                </div>
              )}
              {visited.has('git') && (
                <div className="tool-pane" hidden={pane !== 'git'}>
                  <GitPane
                    projectId={id}
                    editable={editable}
                    revision={revision}
                    visible={pane === 'git'}
                  />
                </div>
              )}
            </aside>
            {showSidebar && (
              <ResizeHandle
                onStart={() => setLeftWidth(dimensions.explorer)}
                onDelta={(delta) => setLeftWidth((v) => Math.max(170, Math.min(480, v + delta)))}
              />
            )}
            <section className="workspace-center">
              <div className="workspace-upper">
                <section className="editor-stack">
                  <div className="editor-tabs">
                    {tabs.map((path) => (
                      <div className={`editor-tab ${active === path ? 'active' : ''}`} key={path}>
                        <button
                          aria-pressed={active === path}
                          onClick={() => {
                            fileIntent.current++;
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
                      <div
                        className="breadcrumbs"
                        title={active}
                        tabIndex={0}
                        aria-label="File path"
                      >
                        {active.split('/').map((part, i) => (
                          <span key={i}>
                            {i > 0 && <ChevronRight size={12} />} {part}
                          </span>
                        ))}
                      </div>
                      <Suspense fallback={<Spinner label="Opening editor…" />}>
                        {tabs.map((path) => (
                          <div
                            className="retained-editor"
                            key={path}
                            style={{ display: active === path ? 'flex' : 'none' }}
                          >
                            <CodeEditor
                              projectId={id}
                              path={path}
                              user={user}
                              editable={editable}
                              active={active === path}
                              onStatus={(s) => {
                                if (path === active) setStatus(s);
                              }}
                              onLanguageStatus={(s) => {
                                if (path === active) setLanguageStatus(s);
                              }}
                              viewStates={viewStates.current}
                              onDefinition={openFile}
                              selection={path === active ? selection : undefined}
                              position={positions.current[path]}
                              onPosition={(pos) => {
                                positions.current[path] = pos;
                                snapshot.current.positions = positions.current;
                                if (restored.current)
                                  savePreferences(preferencesKey, snapshot.current);
                              }}
                            />
                          </div>
                        ))}
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
                      onStart={() => setPreviewWidth(dimensions.preview)}
                      onDelta={(delta) =>
                        setPreviewWidth((v) => Math.max(260, Math.min(720, v - delta)))
                      }
                    />
                    <aside className="preview-pane" style={{ width: dimensions.preview }}>
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
                        <span
                          className="preview-availability"
                          title={
                            url
                              ? 'Preview URL configured; connectivity not checked'
                              : 'Preview unavailable'
                          }
                        />
                        <input aria-label="Preview URL" readOnly value={url} />
                      </div>
                      {project.appStatus.httpStatus && project.appStatus.httpStatus >= 400 && (
                        <p className="form-error">
                          The app responded with HTTP {project.appStatus.httpStatus}.
                        </p>
                      )}
                      {url && project.appStatus.status === 'available' ? (
                        <iframe
                          key={`${project.appStatus.generation}-${previewRevision}`}
                          src={url}
                          title="Project preview"
                          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
                        />
                      ) : (
                        <div className="pane-empty">
                          <p>
                            {project.appStatus.status === 'starting'
                              ? 'Starting app…'
                              : project.appStatus.error || 'Click Run to start your app.'}
                          </p>
                          {editable && project.appStatus.status === 'timeout' && (
                            <button
                              className="button secondary"
                              onClick={() =>
                                post(base + '/readiness').catch((e) => ui.notify(errorMessage(e)))
                              }
                            >
                              Retry readiness
                            </button>
                          )}
                        </div>
                      )}
                    </aside>
                  </>
                )}
              </div>
              {showTerminal && (
                <>
                  <ResizeHandle
                    onStart={() => setTerminalHeight(dimensions.terminal)}
                    horizontal
                    onDelta={(delta) =>
                      setTerminalHeight((v) => Math.max(100, Math.min(550, v - delta)))
                    }
                  />
                  <section className="terminal-panel" style={{ height: dimensions.terminal }}>
                    <div className="terminal-toolbar">
                      <div className="terminal-tabs">
                        <span className="terminal-label">TERMINAL</span>
                        {terminals.map((t) => (
                          <div className="terminal-tab" key={t.id}>
                            <button
                              aria-pressed={terminal === t.id}
                              className={terminal === t.id ? 'active' : ''}
                              onClick={() => setTerminal(t.id)}
                              title={t.name}
                            >
                              <span className={`terminal-dot ${t.alive ? 'alive' : ''}`} />
                              {t.name}
                            </button>
                            {editable && !t.isRun && (
                              <button
                                className="terminal-close"
                                aria-label={`Stop ${t.name}`}
                                onClick={async () => {
                                  try {
                                    await removeTerminal(t.id);
                                    await loadTerminals();
                                  } catch (e) {
                                    ui.notify(errorMessage(e));
                                  }
                                }}
                              >
                                <X size={11} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {editable && (
                        <button
                          className="icon-button"
                          aria-label="New terminal"
                          onClick={async () => {
                            try {
                              const name = await ui.ask({
                                title: 'New terminal',
                                label: 'Terminal name',
                                maxLength: 80,
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
                    {terminalError && <LoadError message={terminalError} onRetry={loadTerminals} />}
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
              {languageStatus && (
                <span className="language-status" title={languageStatus}>
                  {languageStatus}
                </span>
              )}
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
  onStart,
  onDelta,
}: {
  horizontal?: boolean;
  onStart: () => void;
  onDelta: (delta: number) => void;
}) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (
    <div
      className={`resize-handle ${horizontal ? 'horizontal' : ''}`}
      role="separator"
      aria-label={horizontal ? 'Resize terminal' : 'Resize panel'}
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      tabIndex={0}
      onKeyDown={(e) => {
        const decrease = horizontal ? 'ArrowUp' : 'ArrowLeft';
        const increase = horizontal ? 'ArrowDown' : 'ArrowRight';
        if (e.key === decrease || e.key === increase) {
          e.preventDefault();
          onStart();
          onDelta(e.key === decrease ? -10 : 10);
        }
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        cleanup.current?.();
        onStart();
        let previous = horizontal ? e.clientY : e.clientX;
        const move = (event: PointerEvent) => {
          const current = horizontal ? event.clientY : event.clientX;
          onDelta(current - previous);
          previous = current;
        };
        const end = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
          cleanup.current = null;
          document.body.classList.remove('resizing');
        };
        cleanup.current = end;
        document.body.classList.add('resizing');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end, { once: true });
        window.addEventListener('pointercancel', end, { once: true });
      }}
    />
  );
}
