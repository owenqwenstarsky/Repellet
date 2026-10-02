import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Plus, Settings2, Square } from 'lucide-react';
import {
  projectAgentEvent,
  safeRelativePath,
  type AgentSettings as Settings,
  type AgentSnapshot,
  type AgentEvent,
  type AgentMethod,
  type AgentQuestion,
} from '@repellet/shared';
import type { Thread, ThreadItem, Model } from '@repellet/codex-protocol';
import { api, post, wsUrl, errorMessage } from './api';
import { AgentSettings } from './AgentSettings';
import { flushOpenDocuments } from './documentSaves';
import { Button, IconButton, Banner, Spinner, useUi } from './ui';
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
  const [archived, setArchived] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [reconnectRevision, setReconnectRevision] = useState(0);
  const [connected, setConnected] = useState(false);
  const alive = useRef(true);
  const selected = useRef(selectedThread);
  selected.current = selectedThread;
  const mutation = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
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
    const result = await rpc<{ data: Thread[]; nextCursor: string | null }>('thread/list', {
      archived,
      limit: 100,
    });
    if (alive.current) setThreads(result.data.filter((thread) => !thread.parentThreadId));
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
  }, [selectedThread, archived, connectionRevision]);
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
          setEffort((old) => old || fallback.defaultReasoningEffort);
        }
      })
      .catch((e) => {
        if (alive.current) setError(errorMessage(e));
      });
  }, [settings, snapshot?.generation]);
  useEffect(() => {
    const element = transcript.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 300)
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
  const activeHere = active?.threadId === selectedThread;
  const unavailable = busy || !connected || !snapshot?.connected;
  const items = new Map<string, ThreadItem>();
  const storedMessages = new Map<string, Set<string>>();
  function messageKey(item: ThreadItem) {
    if (item.type === 'agentMessage') return 'agent:' + item.text;
    if (item.type === 'userMessage')
      return (
        'user:' +
        item.content
          .filter((content) => content.type === 'text')
          .map((content) => content.text)
          .join('\n')
      );
    return null;
  }
  if (history?.id === selectedThread)
    for (const turn of history.turns) {
      const messages = new Set<string>();
      storedMessages.set(turn.id, messages);
      for (const item of turn.items) {
        items.set(turn.id + ':' + item.id, item);
        const key = messageKey(item);
        if (key !== null) messages.add(key);
      }
    }
  for (const entry of snapshot?.items || [])
    if (entry.threadId === selectedThread) {
      const key = messageKey(entry.item);
      // Legacy Codex assigns synthetic history message IDs, unlike its live IDs.
      if (key !== null && storedMessages.get(entry.turnId)?.has(key)) continue;
      items.set(entry.turnId + ':' + entry.item.id, entry.item);
    }
  return (
    <div className="agent-panel">
      <div className="agent-toolbar">
        <select
          aria-label="Agent thread"
          value={selectedThread}
          onChange={(e) => {
            setHistory(null);
            onSelectThread(e.target.value);
          }}
          disabled={busy}
        >
          <option value="">Choose a conversation</option>
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.name || thread.preview || 'New conversation'}
            </option>
          ))}
        </select>
        <IconButton
          label="New agent thread"
          icon={<Plus size={16} />}
          disabled={unavailable}
          onClick={() =>
            mutate(async () => {
              await newThread();
            })
          }
        />
        <IconButton
          label="Agent settings"
          icon={<Settings2 size={16} />}
          onClick={() => setSettingsOpen(true)}
        />
      </div>
      <div className="agent-thread-actions">
        <Button
          size="sm"
          disabled={unavailable || !selectedThread || !!activeHere}
          onClick={() =>
            mutate(async () => {
              const name = await ui.ask({
                title: 'Rename conversation',
                label: 'Name',
                value: history?.name || '',
                maxLength: 100,
              });
              if (name?.trim()) {
                await rpc('thread/name/set', { threadId: selectedThread, name: name.trim() });
                await loadThreads();
              }
            })
          }
        >
          Rename
        </Button>
        <Button
          size="sm"
          disabled={unavailable || !selectedThread || !!activeHere}
          onClick={() =>
            mutate(async () => {
              const result = await rpc<{ thread: Thread }>('thread/fork', {
                threadId: selectedThread,
              });
              onSelectThread(result.thread.id);
              setHistory(result.thread);
              setArchived(false);
              await loadThreads();
            })
          }
        >
          Fork
        </Button>
        <Button
          size="sm"
          disabled={unavailable || !selectedThread || !!activeHere}
          onClick={() =>
            mutate(async () => {
              await rpc(archived ? 'thread/unarchive' : 'thread/archive', {
                threadId: selectedThread,
              });
              onSelectThread('');
              setHistory(null);
              await loadThreads();
            })
          }
        >
          {archived ? 'Unarchive' : 'Archive'}
        </Button>
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Archived
        </label>
      </div>
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
      <div className="agent-transcript" ref={transcript} aria-label="Agent conversation" role="log">
        {!snapshot && !error && <Spinner />}
        {!selectedThread && (
          <p className="agent-empty">
            Ask Codex to work on your project. Conversations and tool history are saved privately
            for you.
          </p>
        )}
        {[...items].map(([key, item]) => (
          <AgentItem key={key} item={item} onOpenFile={onOpenFile} />
        ))}
        {snapshot?.pending
          .filter(
            (question) => (question.displayThreadId || question.params.threadId) === selectedThread,
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
            ? snapshot?.waiting
              ? 'Waiting for your response'
              : activeHere
                ? 'Working…'
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
        className="agent-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || unavailable) return;
          const submitted = text;
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
                input: [{ type: 'text', text: submitted }],
              });
            } else
              await rpc('turn/start', {
                threadId,
                input: [{ type: 'text', text: submitted }],
                ...(model ? { model } : {}),
                ...(effort ? { effort } : {}),
              });
            if (alive.current) setText('');
          });
        }}
      >
        <textarea
          aria-label="Message Codex"
          placeholder={activeHere ? 'Guide the active turn…' : 'Message Codex…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy || archived}
          rows={3}
          maxLength={100000}
        />
        <div className="agent-composer-options">
          <select
            aria-label="Agent model"
            value={model}
            disabled={unavailable || settings?.mode === 'custom' || !!active}
            onChange={(e) => {
              setModel(e.target.value);
              setEffort(
                models.find((model) => model.model === e.target.value)?.defaultReasoningEffort ||
                  '',
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
          <Button
            type="submit"
            variant="primary"
            disabled={unavailable || !text.trim() || archived || (!!active && !activeHere)}
          >
            {activeHere ? 'Steer' : 'Send'}
          </Button>
        </div>
      </form>
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
export function AgentItem({
  item,
  onOpenFile,
}: {
  item: ThreadItem;
  onOpenFile: (path: string) => void;
}) {
  if (item.type === 'agentMessage' || item.type === 'plan')
    return (
      <article className={`agent-item ${item.type}`}>
        <ReactMarkdown
          skipHtml
          components={{
            img: () => null,
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {item.text}
        </ReactMarkdown>
      </article>
    );
  if (item.type === 'userMessage')
    return (
      <article className="agent-item userMessage">
        {item.content.map((content, index) =>
          content.type === 'text' ? <p key={index}>{content.text}</p> : null,
        )}
      </article>
    );
  if (item.type === 'commandExecution')
    return (
      <details className="agent-activity">
        <summary>
          <code>{item.command}</code> · {item.status}
        </summary>
        <pre>{item.aggregatedOutput || 'Waiting for output…'}</pre>
        {item.exitCode !== null && <small>Exit code {item.exitCode}</small>}
      </details>
    );
  if (item.type === 'fileChange')
    return (
      <details className="agent-activity" open>
        <summary>File changes · {item.status}</summary>
        {item.changes.map((change, index) => {
          let path: string | null = null;
          try {
            path = safeRelativePath(
              change.path.startsWith('/workspace/') ? change.path.slice(11) : change.path,
            );
          } catch {}
          return (
            <div key={index}>
              {path ? (
                <Button variant="link" onClick={() => onOpenFile(path!)}>
                  {path}
                </Button>
              ) : (
                <span>{change.path}</span>
              )}
              <pre className="agent-diff">{change.diff}</pre>
            </div>
          );
        })}
      </details>
    );
  if (item.type === 'reasoning')
    return (
      <details className="agent-activity">
        <summary>Reasoning</summary>
        {item.summary.map((text, index) => (
          <ReactMarkdown key={index} skipHtml>
            {text}
          </ReactMarkdown>
        ))}
      </details>
    );
  return (
    <details className="agent-activity">
      <summary>{item.type}</summary>
      <pre>{JSON.stringify(item, null, 2)}</pre>
    </details>
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
