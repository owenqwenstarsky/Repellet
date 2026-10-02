import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import type { User, TerminalInfo, WorkspacePreferences } from '@repellet/shared';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { api, post, errorMessage, previewUrl } from './api';
import { Spinner, useUi, hasOpenDialog, Button, EmptyState } from './ui';
import { FileTree, SearchPane } from './Files';
import { GitPane } from './GitPane';
import { preferenceKey, readPreferences, savePreferences } from './preferences';
import { flushOpenDocuments } from './documentSaves';
import { QuickOpen } from './QuickOpen';
import { AgentPanel } from './AgentPanel';
import { Tabs } from './ui';
import { ProjectSettings } from './Settings';
import { runEligible } from './workspaceState';
import { useProjectPolling } from './workspace/useProjectPolling';
import { useTerminals } from './workspace/useTerminals';
import { useWorkspaceSocket } from './workspace/useWorkspaceSocket';
import { useWorkspaceLayout } from './workspace/useWorkspaceLayout';
import { useEditorTabs } from './workspace/useEditorTabs';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';
import { WorkspaceBanners } from './workspace/WorkspaceBanners';
import { WorkspaceStartScreen } from './workspace/WorkspaceStartScreen';
import { ActivityBar } from './workspace/ActivityBar';
import { EditorArea } from './workspace/EditorArea';
import { PreviewPanel } from './workspace/PreviewPanel';
import { TerminalPanel } from './workspace/TerminalPanel';
import { StatusBar } from './workspace/StatusBar';
import { ResizeHandle } from './workspace/ResizeHandle';
const Problems = lazy(() => import('./Problems').then((m) => ({ default: m.Problems })));
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
  const ui = useUi();
  const base = `/projects/${id}`;
  const preferencesKey = preferenceKey(user.id, id);
  const [saved] = useState(() => readPreferences(preferencesKey));
  const snapshot = useRef<WorkspacePreferences>(saved);
  const { project, setProject, load, loadError, buildLog, logError, preparationLog, mounted } =
    useProjectPolling(id);
  const editable = !!project && project.role !== 'viewer';
  const ready = project?.state === 'running';
  const terminals = useTerminals(base, saved.terminal, editable, mounted);
  const editor = useEditorTabs(id, saved, project, mounted);
  const layout = useWorkspaceLayout(saved, project?.state);
  const agentOwner = project?.ownerId === user.id;
  const [rightPanel, setRightPanel] = useState<'preview' | 'agent'>(saved.rightPanel || 'preview');
  const [agentThread, setAgentThread] = useState(saved.agentThread || '');
  const [agentVisited, setAgentVisited] = useState(saved.rightPanel === 'agent');
  useEffect(() => {
    if (rightPanel === 'agent') setAgentVisited(true);
  }, [rightPanel]);
  const selectedRightPanel = agentOwner ? rightPanel : 'preview';
  const [quickOpen, setQuickOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [peers, setPeers] = useState<{ id: string; name: string }[]>([]);
  const [indexRevision, setIndexRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [status, setStatus] = useState('');
  const [languageStatus, setLanguageStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const runPending = useRef(false);
  const latestProject = useRef(project);
  latestProject.current = project;
  const canRun =
    editable &&
    ready &&
    !project.storageExceeded &&
    ['none', 'ready'].includes(project.preparation.status) &&
    !busy;
  const { connected } = useWorkspaceSocket(id, !!ready, project?.role, {
    onMessage(message) {
      if (message.type === 'presence') setPeers(message.peers);
      if (message.type === 'file' || message.type === 'files') setRevision((v) => v + 1);
      if (
        message.type === 'files' ||
        (message.type === 'file' &&
          ['add', 'addDir', 'unlink', 'unlinkDir'].includes(message.event))
      )
        setIndexRevision((v) => v + 1);
      if (message.type === 'file' && ['unlink', 'unlinkDir'].includes(message.event))
        editor.dropPath(message.path);
      if (message.type === 'terminals') void terminals.reload();
      if (message.type === 'state') void load();
      if (message.type === 'structure') {
        setIndexRevision((v) => v + 1);
        setRevision((v) => v + 1);
        editor.applyStructure({ from: message.from, to: message.to });
      }
      if (message.type === 'storage')
        setProject((p) =>
          p ? { ...p, storageBytes: message.bytes, storageExceeded: message.exceeded } : p,
        );
      if (message.type === 'error') ui.notify(message.message);
    },
    onRevoked(reason) {
      void load();
      ui.notify(reason);
    },
  });
  useEffect(() => {
    if (!ready) return;
    void terminals.reload();
    const timer = setInterval(terminals.reload, 2500);
    return () => clearInterval(timer);
  }, [id, ready, project?.role]);
  useEffect(() => {
    snapshot.current = {
      version: 1,
      tabs: editor.tabs,
      active: editor.active,
      positions: editor.positions.current,
      pane: layout.pane,
      showSidebar: layout.showSidebar,
      showPreview: layout.showPreview,
      rightPanel: selectedRightPanel,
      agentThread,
      showTerminal: layout.showTerminal,
      leftWidth: layout.leftWidth,
      previewWidth: layout.previewWidth,
      terminalHeight: layout.terminalHeight,
      terminal: terminals.terminal,
    };
    if (editor.restored.current) savePreferences(preferencesKey, snapshot.current);
  }, [
    editor.tabs,
    editor.active,
    layout.pane,
    layout.showSidebar,
    layout.showPreview,
    selectedRightPanel,
    agentThread,
    layout.showTerminal,
    layout.leftWidth,
    layout.previewWidth,
    layout.terminalHeight,
    terminals.terminal,
  ]);
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
      layout.setShowTerminal(true);
      terminals.setTerminal('run');
      await terminals.reload();
      terminals.setTerminal('run');
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
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setQuickOpen(true);
      }
      if (mod && e.key === 'Enter' && editable) {
        e.preventDefault();
        void run();
      }
      if (mod && e.key === 's') e.preventDefault();
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        layout.revealPane('search');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [project, editable, busy]);
  async function createTerminal() {
    try {
      const name = await ui.ask({
        title: 'New terminal',
        label: 'Terminal name',
        maxLength: 80,
        value: `Terminal ${terminals.terminals.filter((t) => !t.isRun).length + 1}`,
      });
      if (!name) return;
      const created = await post<TerminalInfo>(base + '/terminals', { name });
      await terminals.reload();
      terminals.setTerminal(created.id);
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  async function stopTerminal(terminalId: string) {
    try {
      await api(base + '/terminals/' + terminalId, { method: 'DELETE' });
      await terminals.reload();
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  if (loadError && !project)
    return (
      <div className="workspace-load-error">
        <EmptyState
          icon={<AlertTriangle size={28} />}
          title="Workspace unavailable"
          description={loadError}
          action={
            <div className="page-actions">
              <Button icon={<ArrowLeft size={15} />} onClick={onBack}>
                Back to projects
              </Button>
              <Button variant="primary" onClick={load}>
                Retry
              </Button>
            </div>
          }
        />
      </div>
    );
  if (!project) return <Spinner label="Opening workspace…" />;
  const running = terminals.terminals.some((t) => t.isRun && t.alive);
  const url = project.previewPort ? previewUrl(project.previewPort) : '';
  const { dimensions } = layout;
  return (
    <div className="workspace">
      {quickOpen && (
        <QuickOpen
          projectId={id}
          revision={indexRevision}
          onOpen={editor.openFile}
          onClose={() => setQuickOpen(false)}
        />
      )}
      <WorkspaceHeader
        project={project}
        peers={peers}
        editable={editable}
        canRun={canRun}
        busy={busy}
        running={running}
        onBack={onBack}
        onRun={run}
        onSettings={() => setSettings(true)}
        onStopApp={async () => {
          try {
            await post(base + '/run/stop');
            await terminals.reload();
          } catch (e) {
            ui.notify(errorMessage(e));
          }
        }}
      />
      <WorkspaceBanners
        project={project}
        loadError={loadError}
        preparationLog={preparationLog}
        editable={editable}
        onRetryLoad={load}
        onRetryPreparation={() => post(base + '/prepare').catch((e) => ui.notify(errorMessage(e)))}
      />
      {!ready ? (
        <WorkspaceStartScreen
          project={project}
          buildLog={buildLog}
          logError={logError}
          onRetryLog={load}
          onStart={() =>
            post(base + '/open')
              .then(() => load())
              .catch((e) => ui.notify(errorMessage(e)))
          }
        />
      ) : (
        <>
          <div className="workspace-body" ref={layout.bodyRef}>
            <ActivityBar
              pane={layout.pane}
              showSidebar={layout.showSidebar}
              showTerminal={layout.showTerminal}
              showPreview={layout.showPreview}
              onPane={layout.selectPane}
              onToggleTerminal={() => layout.setShowTerminal(!layout.showTerminal)}
              onTogglePreview={() => {
                setRightPanel('preview');
                layout.setShowPreview(
                  selectedRightPanel === 'preview' ? !layout.showPreview : true,
                );
              }}
              agentOwner={agentOwner}
              agentActive={layout.showPreview && selectedRightPanel === 'agent'}
              onAgent={() => {
                setRightPanel('agent');
                layout.setShowPreview(selectedRightPanel === 'agent' ? !layout.showPreview : true);
              }}
            />
            <aside
              className="explorer"
              hidden={!layout.showSidebar}
              style={{ width: layout.showSidebar ? dimensions.explorer : 0 }}
            >
              <div className="tool-pane" hidden={layout.pane !== 'files'}>
                <FileTree
                  projectId={id}
                  active={editor.active}
                  onOpen={editor.openFile}
                  editable={editable}
                  revision={revision}
                  visible={layout.pane === 'files'}
                  structure={editor.structure}
                />
              </div>
              {layout.visited.has('search') && (
                <div className="tool-pane" hidden={layout.pane !== 'search'}>
                  <SearchPane
                    projectId={id}
                    editable={editable}
                    onOpen={editor.openFile}
                    visible={layout.pane === 'search'}
                  />
                </div>
              )}
              {layout.visited.has('problems') && (
                <div className="tool-pane" hidden={layout.pane !== 'problems'}>
                  <Suspense fallback={<Spinner />}>
                    <Problems projectId={id} tabs={editor.tabs} onOpen={editor.openFile} />
                  </Suspense>
                </div>
              )}
              {layout.visited.has('git') && (
                <div className="tool-pane" hidden={layout.pane !== 'git'}>
                  <GitPane
                    projectId={id}
                    editable={editable}
                    revision={revision}
                    visible={layout.pane === 'git'}
                  />
                </div>
              )}
            </aside>
            {layout.showSidebar && (
              <ResizeHandle
                onStart={() => layout.setLeftWidth(dimensions.explorer)}
                onDelta={(delta) =>
                  layout.setLeftWidth((v) => Math.max(170, Math.min(480, v + delta)))
                }
              />
            )}
            <section className="workspace-center">
              <div className="workspace-upper">
                <EditorArea
                  projectId={id}
                  projectName={project.name}
                  user={user}
                  editable={editable}
                  tabs={editor.tabs}
                  active={editor.active}
                  selection={editor.selection}
                  positions={editor.positions}
                  viewStates={editor.viewStates}
                  onSelect={editor.selectTab}
                  onClose={editor.closeTab}
                  onOpen={editor.openFile}
                  onStatus={setStatus}
                  onLanguageStatus={setLanguageStatus}
                  onPosition={(path, pos) => {
                    editor.positions.current[path] = pos;
                    snapshot.current.positions = editor.positions.current;
                    if (editor.restored.current) savePreferences(preferencesKey, snapshot.current);
                  }}
                />
                {layout.showPreview && (
                  <>
                    <ResizeHandle
                      onStart={() => layout.setPreviewWidth(dimensions.preview)}
                      onDelta={(delta) =>
                        layout.setPreviewWidth((v) => Math.max(260, Math.min(720, v - delta)))
                      }
                    />
                    <aside className="workspace-right-panel" style={{ width: dimensions.preview }}>
                      {agentOwner && (
                        <Tabs
                          label="Workspace right panel"
                          value={selectedRightPanel}
                          onChange={setRightPanel}
                          items={[
                            { id: 'preview', label: 'Preview' },
                            { id: 'agent', label: 'Agent' },
                          ]}
                        />
                      )}
                      <div
                        className="workspace-right-content"
                        hidden={selectedRightPanel !== 'preview'}
                      >
                        <PreviewPanel
                          project={project}
                          url={url}
                          width={dimensions.preview}
                          revision={previewRevision}
                          editable={editable}
                          onRefresh={() => setPreviewRevision((v) => v + 1)}
                          onClose={() => layout.setShowPreview(false)}
                          onRetryReadiness={() =>
                            post(base + '/readiness').catch((e) => ui.notify(errorMessage(e)))
                          }
                        />
                      </div>
                      {agentOwner && agentVisited && (
                        <div
                          className="workspace-right-content"
                          hidden={selectedRightPanel !== 'agent'}
                        >
                          <AgentPanel
                            projectId={id}
                            selectedThread={agentThread}
                            onSelectThread={setAgentThread}
                            onOpenFile={editor.openFile}
                          />
                        </div>
                      )}
                    </aside>
                  </>
                )}
              </div>
              {layout.showTerminal && (
                <>
                  <ResizeHandle
                    horizontal
                    onStart={() => layout.setTerminalHeight(dimensions.terminal)}
                    onDelta={(delta) =>
                      layout.setTerminalHeight((v) => Math.max(100, Math.min(550, v - delta)))
                    }
                  />
                  <TerminalPanel
                    projectId={id}
                    height={dimensions.terminal}
                    terminals={terminals.terminals}
                    terminal={terminals.terminal}
                    error={terminals.error}
                    editable={editable}
                    onSelect={terminals.setTerminal}
                    onStop={stopTerminal}
                    onCreate={createTerminal}
                    onHide={() => layout.setShowTerminal(false)}
                    onRetry={terminals.reload}
                  />
                </>
              )}
            </section>
          </div>
          <StatusBar
            project={project}
            connected={connected}
            status={editor.active ? status : ''}
            languageStatus={editor.active ? languageStatus : ''}
          />
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
}
