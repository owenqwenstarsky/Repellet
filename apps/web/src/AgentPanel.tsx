import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, Settings2, Square, MoreHorizontal, ListChecks, Paperclip } from 'lucide-react';
import {
  projectAgentEvent,
  type AgentSettings as Settings,
  type AgentSnapshot,
  type AgentEvent,
  type AgentMethod,
  type AgentQuestion,
} from '@repellet/shared';
import type { Thread, Model } from '@repellet/agent-protocol';
import { api, post, wsUrl, errorMessage } from './api';
import { AgentSettings } from './AgentSettings';
import { agentTranscript } from './agentTranscript';
import { AgentTranscriptItems } from './AgentItems';
import { useAgentAttachments, AgentDraftAttachments, attachmentAccept } from './AgentAttachments';
export { AgentItem, AgentTranscriptItems } from './AgentItems';
import { flushOpenDocuments } from './documentSaves';
import { Button, IconButton, Banner, Spinner, MenuButton, MenuItem, useUi } from './ui';
export function AgentPanel({
  projectId,
  selectedThread,
  onSelectThread,
  onOpenFile,
}: {
  projectId: string;
  selectedThread: string;
  onSelectThread: (id: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const base = `/projects/${projectId}/agent`;
  const ui = useUi();
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const current = useRef<AgentSnapshot | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [history, setHistory] = useState<Thread | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runSettingsOpen, setRunSettingsOpen] = useState(false);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [text, setText] = useState('');
  const attachments = useAgentAttachments(projectId, selectedThread);
  const filePicker = useRef<HTMLInputElement>(null);
  const [pasteChoice, setPasteChoice] = useState<{
    text: string;
    start: number;
    end: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [reconnectRevision, setReconnectRevision] = useState(0);
  const [connected, setConnected] = useState(false);
  const alive = useRef(true);
  const selected = useRef(selectedThread);
  selected.current = selectedThread;
  const mutation = useRef(false);
  const listRevision = useRef(0);
  const transcript = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  const drafts = useRef(new Map<string, string>());
  const restored = useRef(false);
  useLayoutEffect(() => {
    const element = transcript.current;
    setText(drafts.current.get(selectedThread) || '');
    restored.current = false;
    if (element) element.scrollTop = scrollPositions.current.get(selectedThread) || 0;
    setRunSettingsOpen(false);
    setPasteChoice(null);
    setDragging(false);
    return () => {
      if (element) scrollPositions.current.set(selectedThread, element.scrollTop);
    };
  }, [selectedThread]);
  function accept(value: AgentSnapshot) {
    current.current = value;
    setSnapshot(value);
  }
  async function reconcile() {
    const value = await api<AgentSnapshot>(base + '/status');
    if (alive.current) accept(value);
    return value;
  }
  async function rpc<T = any>(
    method: AgentMethod,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const value = current.current?.connected ? current.current : await reconcile();
    return post<T>(base + '/rpc', { generation: value.generation, method, params });
  }
  async function loadThreads() {
    const revision = ++listRevision.current;
    const result = await rpc<{ data: Thread[]; nextCursor: string | null }>('thread/list', {
      archived,
      limit: 100,
      ...(search.trim() ? { search: search.trim() } : {}),
    });
    if (alive.current && revision === listRevision.current)
      setThreads(result.data.filter((thread) => !thread.parentThreadId));
  }
  async function loadHistory(id: string) {
    const result = await rpc<{ thread: Thread }>('thread/read', {
      threadId: id,
      includeTurns: true,
    });
    if (alive.current && selected.current === id) setHistory(result.thread);
  }
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    async function connect() {
      try {
        await reconcile();
        const value = await api<Settings>('/agent/settings');
        if (!disposed) setSettings(value);
        if (disposed) return;
        socket = new WebSocket(wsUrl(`/ws/projects/${projectId}/agent`));
        socket.onmessage = (event) => {
          if (disposed) return;
          try {
            const message = JSON.parse(event.data) as AgentEvent;
            if (message.type === 'snapshot') {
              accept(message.snapshot);
              setConnected(true);
              delay = 500;
              setConnectionRevision((value) => value + 1);
            } else if (current.current) {
              if (
                message.generation !== current.current.generation ||
                message.sequence !== current.current.sequence + 1
              ) {
                socket?.close();
                return;
              }
              accept(projectAgentEvent(current.current, message));
              if (
                message.type === 'event' &&
                [
                  'turn/completed',
                  'thread/name/updated',
                  'thread/archived',
                  'thread/unarchived',
                  'thread/planMode/updated',
                ].includes(message.event.method)
              )
                setConnectionRevision((value) => value + 1);
            }
          } catch {
            socket?.close();
          }
        };
        socket.onclose = (event) => {
          if (disposed) return;
          setConnected(false);
          if (event.code === 1008) {
            setError(event.reason || 'Agent access revoked');
            return;
          }
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 10000);
        };
        socket.onerror = () => socket?.close();
      } catch (e) {
        if (!disposed) {
          setError(errorMessage(e));
          setConnected(false);
        }
      }
    }
    void connect();
    return () => {
      disposed = true;
      alive.current = false;
      clearTimeout(retry);
      socket?.close();
    };
  }, [base, reconnectRevision]);
  useEffect(() => {
    if (!snapshot?.connected) return;
    void loadThreads().catch((e) => {
      if (alive.current) setError(errorMessage(e));
    });
    if (selectedThread)
      void loadHistory(selectedThread).catch((e) => {
        if (alive.current) setError(errorMessage(e));
      });
  }, [selectedThread, archived, search, connectionRevision]);
  useEffect(() => {
    if (!snapshot?.connected || !settings) return;
    if (settings.mode === 'custom') {
      setModel(settings.model);
      setEffort(settings.effort || '');
      setModels([]);
      return;
    }
    void rpc<{ data: Model[] }>('model/list', { limit: 100 })
      .then((result) => {
        if (!alive.current) return;
        setModels(result.data);
        const fallback = result.data.find((model) => model.isDefault) || result.data[0];
        if (fallback) {
          setModel((old) => old || fallback.model);
          setEffort((old) => old || fallback.defaultReasoningEffort || '');
        }
      })
      .catch((e) => {
        if (alive.current) setError(errorMessage(e));
      });
  }, [settings, snapshot?.generation]);
  useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    if (history?.id === selectedThread && !restored.current) {
      element.scrollTop = scrollPositions.current.get(selectedThread) ?? element.scrollHeight;
      restored.current = true;
    } else if (element.scrollHeight - element.scrollTop - element.clientHeight < 300)
      element.scrollTop = element.scrollHeight;
  }, [snapshot?.sequence, history]);
  async function mutate(operation: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
      // Recover status/history after any lost mutation response. Never replay a prompt.
      try {
        await reconcile();
        await loadThreads();
        if (selected.current) await loadHistory(selected.current);
      } catch {}
    } finally {
      mutation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function newThread() {
    const result = await rpc<{ thread: Thread }>('thread/start', { ...(model ? { model } : {}) });
    if (alive.current) {
      onSelectThread(result.thread.id);
      setHistory(result.thread);
      setArchived(false);
      await loadThreads();
    }
    return result.thread.id;
  }
  const active = snapshot?.active;
  const filteredThreads = threads.filter((thread) => {
    const query = search.trim().toLowerCase();
    return !query || `${thread.name || ''} ${thread.preview || ''}`.toLowerCase().includes(query);
  });
  const relativeTime = (stamp: number | string | null | undefined) => {
    const seconds = Math.max(
      0,
      Math.round(
        Date.now() / 1000 -
          (typeof stamp === 'number' ? stamp : Date.parse(String(stamp || 0)) / 1000),
      ),
    );
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
  };
  function renameThread(thread: Thread | null) {
    void mutate(async () => {
      const name = await ui.ask({
        title: 'Rename conversation',
        label: 'Name',
        value: thread?.name || '',
        maxLength: 100,
      });
      if (name?.trim()) {
        await rpc('thread/name/set', { threadId: thread?.id || selectedThread, name: name.trim() });
        await loadThreads();
        if (selected.current) await loadHistory(selected.current);
      }
    });
  }
  function forkThread(id: string) {
    void mutate(async () => {
      const result = await rpc<{ thread: Thread }>('thread/fork', { threadId: id });
      onSelectThread(result.thread.id);
      setHistory(result.thread);
      setArchived(false);
      await loadThreads();
    });
  }
  function archiveThread(id: string) {
    void mutate(async () => {
      await rpc(archived ? 'thread/unarchive' : 'thread/archive', { threadId: id });
      if (selected.current === id) {
        onSelectThread('');
        setHistory(null);
      }
      await loadThreads();
    });
  }
  const activeHere = active?.threadId === selectedThread;
  const unavailable = busy || !connected || !snapshot?.connected;
  const items = agentTranscript(selectedThread, history, snapshot?.items || []);
  function insertPaste(value: { text: string; start: number; end: number }, attach: boolean) {
    if (
      attach &&
      !attachments.add(
        [new File([value.text], 'pasted-text.txt', { type: 'text/plain' })],
        ui.notify,
        'Pasted text',
      )
    )
      return;
    setText((currentText) => {
      const next =
        currentText.slice(0, value.start) +
        (attach ? '' : value.text) +
        currentText.slice(value.end);
      drafts.current.set(selectedThread, next);
      return next;
    });
    setPasteChoice(null);
  }
  return (
    <div className="agent-panel">
      {!selectedThread ? (
        <>
          <div className="agent-toolbar agent-threads-header">
            <h2>Threads</h2>
            <Button
              variant="primary"
              size="sm"
              disabled={unavailable}
              onClick={() =>
                mutate(async () => {
                  await newThread();
                })
              }
            >
              <Plus size={15} /> New thread
            </Button>
            <IconButton
              label="Agent settings"
              icon={<Settings2 size={16} />}
              onClick={() => setSettingsOpen(true)}
            />
            <label className="agent-thread-search">
              <span className="sr-only">Search threads</span>
              <input
                aria-label="Search threads"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search threads"
              />
            </label>
            <label className="agent-archive-filter">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />{' '}
              Archived
            </label>
          </div>
          <div
            className="agent-thread-list"
            role="list"
            aria-label="Threads"
            onKeyDown={(event) => {
              if (
                !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
                !(event.target as HTMLElement).matches('.agent-thread-row')
              )
                return;
              const rows = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('.agent-thread-row'),
              ];
              const index = rows.indexOf(event.target as HTMLButtonElement);
              event.preventDefault();
              rows[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? rows.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
              ]?.focus();
            }}
          >
            {filteredThreads.length === 0 ? (
              <div className="agent-empty-state">
                <p>
                  {search
                    ? 'No threads match your search.'
                    : archived
                      ? 'No archived threads.'
                      : 'Start a thread to work on this project.'}
                </p>
                {!search && !archived && (
                  <Button
                    variant="primary"
                    disabled={unavailable}
                    onClick={() =>
                      mutate(async () => {
                        await newThread();
                      })
                    }
                  >
                    Start a thread
                  </Button>
                )}
              </div>
            ) : (
              filteredThreads.map((thread) => (
                <div className="agent-thread-entry" role="listitem" key={thread.id}>
                  <button
                    className="agent-thread-row"
                    onClick={() => {
                      setHistory(null);
                      onSelectThread(thread.id);
                    }}
                    disabled={busy}
                  >
                    <span className="agent-thread-row-main">
                      <strong>{thread.name || thread.preview || 'New conversation'}</strong>
                      <span>{thread.preview || 'No messages yet'}</span>
                    </span>
                    <time>{relativeTime(thread.updatedAt)}</time>
                    {active?.threadId === thread.id && (
                      <span className="agent-thread-active" aria-label="Working">
                        ●
                      </span>
                    )}
                  </button>
                  <MenuButton
                    label={`Actions for ${thread.name || thread.preview || 'New conversation'}`}
                    icon={<MoreHorizontal size={16} />}
                  >
                    <MenuItem
                      disabled={unavailable || active?.threadId === thread.id}
                      onSelect={() => renameThread(thread)}
                    >
                      Rename
                    </MenuItem>
                    <MenuItem
                      disabled={unavailable || active?.threadId === thread.id}
                      onSelect={() => forkThread(thread.id)}
                    >
                      Fork
                    </MenuItem>
                    <MenuItem
                      disabled={unavailable || active?.threadId === thread.id}
                      onSelect={() => archiveThread(thread.id)}
                    >
                      {archived ? 'Unarchive' : 'Archive'}
                    </MenuItem>
                  </MenuButton>
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <div className="agent-toolbar agent-detail-header">
          <Button size="sm" variant="ghost" onClick={() => onSelectThread('')}>
            ← Threads
          </Button>
          <h2 title={history?.name || 'New conversation'}>{history?.name || 'New conversation'}</h2>
          <MenuButton label="Thread actions" icon={<MoreHorizontal size={16} />}>
            <MenuItem disabled={unavailable || activeHere} onSelect={() => renameThread(history)}>
              Rename
            </MenuItem>
            <MenuItem
              disabled={unavailable || activeHere}
              onSelect={() => forkThread(selectedThread)}
            >
              Fork
            </MenuItem>
            <MenuItem
              disabled={unavailable || activeHere}
              onSelect={() => archiveThread(selectedThread)}
            >
              {archived ? 'Unarchive' : 'Archive'}
            </MenuItem>
          </MenuButton>
          <IconButton
            label="Agent settings"
            icon={<Settings2 size={16} />}
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      )}
      {error && (
        <Banner tone="danger" compact>
          {error}
          <Button
            size="sm"
            onClick={() =>
              mutate(async () => {
                setReconnectRevision((value) => value + 1);
              })
            }
          >
            Refresh status
          </Button>
        </Banner>
      )}
      {snapshot?.error && (
        <Banner tone="danger" compact>
          {snapshot.error}
        </Banner>
      )}
      {selectedThread && (
        <>
          <div
            className="agent-transcript"
            ref={transcript}
            aria-label="Agent conversation"
            role="log"
          >
            {!snapshot && !error && <Spinner />}
            <AgentTranscriptItems items={items} onOpenFile={onOpenFile} projectId={projectId} />
            {snapshot?.pending
              .filter(
                (question) =>
                  (question.displayThreadId || question.params.threadId) === selectedThread,
              )
              .map((question) => (
                <Question
                  key={question.id}
                  question={question}
                  disabled={unavailable}
                  onAnswer={(answers) =>
                    mutate(async () => {
                      await rpc('question/respond', { requestId: question.id, answers });
                    })
                  }
                />
              ))}
          </div>
          <div className="agent-status" role="status">
            {!connected
              ? 'Agent disconnected'
              : active
                ? activeHere
                  ? snapshot?.waiting
                    ? 'Waiting for your response'
                    : 'Working…'
                  : snapshot?.waiting
                    ? 'Another conversation is waiting for input'
                    : 'Another conversation is working'
                : 'Ready'}
            {active && (
              <Button
                size="sm"
                disabled={busy || !snapshot?.connected}
                icon={<Square size={12} />}
                onClick={() =>
                  mutate(async () => {
                    await rpc('turn/interrupt', active);
                  })
                }
              >
                Stop
              </Button>
            )}
          </div>
          <form
            className={`agent-composer${dragging ? ' agent-composer-dragging' : ''}`}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return;
              event.preventDefault();
              if (!busy && !archived) setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!busy && !archived) attachments.add([...event.dataTransfer.files], ui.notify);
            }}
            onSubmit={(event) => {
              event.preventDefault();
              if (
                (!text.trim() && !attachments.input.length) ||
                unavailable ||
                archived ||
                attachments.blocked ||
                pasteChoice
              )
                return;
              const submitted = text;
              const input = [
                ...(submitted.trim() ? [{ type: 'text', text: submitted }] : []),
                ...attachments.input,
              ];
              void mutate(async () => {
                await flushOpenDocuments(projectId);
                const threadId = selectedThread || (await newThread());
                const turn = current.current?.active;
                if (turn) {
                  if (turn.threadId !== threadId)
                    throw new Error('Stop the active conversation before starting another turn');
                  await rpc('turn/steer', {
                    threadId,
                    expectedTurnId: turn.turnId,
                    input,
                  });
                } else
                  await rpc('turn/start', {
                    threadId,
                    input,
                    ...(model ? { model } : {}),
                    ...(effort ? { effort } : {}),
                  });
                if (alive.current) {
                  drafts.current.delete(threadId);
                  attachments.clear(threadId);
                  if (selected.current === threadId) setText('');
                }
              });
            }}
          >
            <input
              ref={filePicker}
              type="file"
              multiple
              accept={attachmentAccept}
              className="hidden"
              aria-label="Attach images or text files"
              disabled={busy || archived}
              onChange={(event) => {
                attachments.add([...(event.currentTarget.files || [])], ui.notify);
                event.currentTarget.value = '';
              }}
            />
            <AgentDraftAttachments
              entries={attachments.entries}
              disabled={busy || archived}
              onRemove={attachments.remove}
              onRetry={(entry) => {
                void attachments.retry(entry);
              }}
            />
            {pasteChoice && (
              <div className="agent-paste-choice" role="group" aria-label="Paste large text">
                <span>Paste {pasteChoice.text.length.toLocaleString()} characters</span>
                <Button size="sm" onClick={() => insertPaste(pasteChoice, true)}>
                  Attach as text file
                </Button>
                <Button size="sm" onClick={() => insertPaste(pasteChoice, false)}>
                  Paste inline
                </Button>
                <Button size="sm" onClick={() => setPasteChoice(null)}>
                  Cancel
                </Button>
              </div>
            )}
            <textarea
              aria-label="Message agent"
              placeholder={activeHere ? 'Guide the active turn…' : 'Message agent…'}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                drafts.current.set(selectedThread, e.target.value);
              }}
              onPaste={(event) => {
                if (busy || archived || pasteChoice) {
                  event.preventDefault();
                  return;
                }
                const files = [...event.clipboardData.files];
                if (files.length) {
                  event.preventDefault();
                  attachments.add(files, ui.notify);
                  return;
                }
                const pasted = event.clipboardData.getData('text/plain');
                if (pasted.length < 1000) return;
                event.preventDefault();
                const value = {
                  text: pasted,
                  start: event.currentTarget.selectionStart,
                  end: event.currentTarget.selectionEnd,
                };
                if (pasted.length > 5000) insertPaste(value, true);
                else setPasteChoice(value);
              }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              disabled={busy || archived || !!pasteChoice}
              rows={3}
              maxLength={100000}
            />
            <div className="agent-composer-options" role="group" aria-label="Composer actions">
              <IconButton
                label="Attach files"
                icon={<Paperclip size={15} />}
                disabled={busy || archived}
                onClick={() => filePicker.current?.click()}
              />
              <div className="agent-run-settings-wrap">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={runSettingsOpen}
                  aria-controls="agent-run-settings"
                  onClick={() => setRunSettingsOpen((value) => !value)}
                >
                  Run settings
                </Button>
                {runSettingsOpen && (
                  <div
                    className="agent-run-settings-popover"
                    id="agent-run-settings"
                    role="group"
                    aria-label="Model and reasoning"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setRunSettingsOpen(false);
                      }
                    }}
                  >
                    <select
                      aria-label="Agent model"
                      value={model}
                      disabled={unavailable || settings?.mode === 'custom' || !!active}
                      onChange={(e) => {
                        setModel(e.target.value);
                        setEffort(
                          models.find((model) => model.model === e.target.value)
                            ?.defaultReasoningEffort || '',
                        );
                      }}
                    >
                      <option value="">Default model</option>
                      {settings?.mode === 'custom' ? (
                        <option value={settings.model}>{settings.model}</option>
                      ) : (
                        models.map((model) => (
                          <option key={model.id} value={model.model}>
                            {model.displayName}
                          </option>
                        ))
                      )}
                    </select>
                    <select
                      aria-label="Agent effort"
                      value={effort}
                      disabled={unavailable || settings?.mode === 'custom' || !!active}
                      onChange={(e) => setEffort(e.target.value)}
                    >
                      <option value="">Default effort</option>
                      {settings?.mode === 'custom' && settings.effort ? (
                        <option value={settings.effort}>{settings.effort}</option>
                      ) : (
                        models
                          .find((item) => item.model === model)
                          ?.supportedReasoningEfforts.map((option) => (
                            <option key={option.reasoningEffort} value={option.reasoningEffort}>
                              {option.reasoningEffort}
                            </option>
                          ))
                      )}
                    </select>
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="agent-plan-toggle"
                aria-pressed={history?.planMode === true}
                title={
                  history?.planMode ? 'Leave read-only plan mode' : 'Plan before making changes'
                }
                disabled={unavailable || busy || archived || !!active}
                onClick={() =>
                  mutate(async () => {
                    const result = await rpc<{ thread: Thread }>('thread/plan/toggle', {
                      threadId: selectedThread,
                    });
                    if (alive.current && selected.current === selectedThread)
                      setHistory((current) =>
                        current ? { ...current, planMode: result.thread.planMode } : current,
                      );
                  })
                }
              >
                <ListChecks size={14} aria-hidden="true" />
                Plan mode
              </Button>
              <span className="agent-keyboard-hint">⌘ / Ctrl + Enter</span>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  unavailable ||
                  (!text.trim() && !attachments.input.length) ||
                  attachments.blocked ||
                  !!pasteChoice ||
                  archived ||
                  (!!active && !activeHere)
                }
              >
                {activeHere ? 'Steer' : 'Send'}
              </Button>
            </div>
          </form>
        </>
      )}
      {settingsOpen && (
        <AgentSettings
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            void api<Settings>('/agent/settings').then(setSettings);
            setReconnectRevision((value) => value + 1);
          }}
        />
      )}
    </div>
  );
}
function Question({
  question,
  disabled,
  onAnswer,
}: {
  question: AgentQuestion;
  disabled: boolean;
  onAnswer: (answers: Record<string, { answers: string[] }>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <form
      className="agent-question"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(
          Object.fromEntries(
            question.params.questions.map((question) => [
              question.id,
              { answers: [answers[question.id] || ''] },
            ]),
          ),
        );
      }}
    >
      {question.params.questions.map((question) => (
        <fieldset key={question.id} disabled={disabled}>
          <legend>{question.header}</legend>
          <p>{question.question}</p>
          {question.options?.map((option) => (
            <label key={option.label}>
              <input
                type="radio"
                name={question.id}
                checked={answers[question.id] === option.label}
                onChange={() => setAnswers({ ...answers, [question.id]: option.label })}
              />
              {option.label}
              <small>{option.description}</small>
            </label>
          ))}
          <input
            aria-label={question.question}
            type={question.isSecret ? 'password' : 'text'}
            value={answers[question.id] || ''}
            onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
            required
          />
        </fieldset>
      ))}
      <Button
        type="submit"
        disabled={
          disabled || question.params.questions.some((question) => !answers[question.id]?.trim())
        }
      >
        Answer
      </Button>
    </form>
  );
}
