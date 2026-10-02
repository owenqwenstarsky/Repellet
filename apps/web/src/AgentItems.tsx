import ReactMarkdown from 'react-markdown';
import { ChevronRight } from 'lucide-react';
import { safeRelativePath } from '@repellet/shared';
import type { ThreadItem } from '@repellet/codex-protocol';
import { Button } from './ui';
import { groupAgentTools, type AgentTranscriptEntry } from './agentTranscript';
import {
  activityName,
  toolCategory,
  toolContent,
  toolFailed,
  toolInput,
  toolOutput,
} from './toolActivity';

export function AgentTranscriptItems({
  items,
  onOpenFile,
}: {
  items: AgentTranscriptEntry[];
  onOpenFile: (path: string) => void;
}) {
  return groupAgentTools(items).map((group) => {
    if (group.type === 'item')
      return <AgentItem key={group.key} item={group.entry.item} onOpenFile={onOpenFile} />;
    const failed = group.entries.filter(({ item }) => toolFailed(item)).length;
    const running = group.entries.some(
      ({ item }) => 'status' in item && ['inProgress', 'in_progress'].includes(item.status),
    );
    const categories = [...new Set(group.entries.map(({ item }) => toolCategory(item)))];
    return (
      <details className="agent-tool-run" key={group.key}>
        <summary>
          <ChevronRight size={14} className="agent-tool-run-chevron" aria-hidden="true" />
          <span className="agent-tool-run-count">{group.entries.length} tools</span>
          <span className="agent-tool-run-labels">{categories.join(' · ')}</span>
          {failed > 0 && <span className="agent-tool-run-failed">{failed} failed</span>}
          {running && <span className="agent-tool-run-running">Working…</span>}
        </summary>
        <div className="agent-tool-run-content">
          {group.entries.map(({ key, item }) => (
            <AgentItem key={key} item={item} onOpenFile={onOpenFile} />
          ))}
        </div>
      </details>
    );
  });
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
        <pre>
          {item.aggregatedOutput ||
            (item.status === 'inProgress' ? 'Waiting for output…' : 'No output.')}
        </pre>
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
  if (item.type === 'dynamicToolCall') {
    const input = toolInput(item.arguments);
    const output = item.contentItems
      ?.filter((content) => content.type === 'inputText')
      .map((content) => toolOutput(content.text))
      .join('\n');
    return (
      <details className="agent-activity">
        <summary>
          <code>{[item.namespace, item.tool].filter(Boolean).join('.')}</code> · {item.status}
        </summary>
        {input && (
          <>
            <small>
              {item.tool === 'exec' && typeof item.arguments === 'string' ? 'Script' : 'Input'}
            </small>
            <pre aria-label="Tool input">{input}</pre>
          </>
        )}
        <pre aria-label="Tool output">
          {output || (item.status === 'inProgress' ? 'Waiting for output…' : 'No text output.')}
        </pre>
        {item.contentItems?.some((content) => content.type !== 'inputText') && (
          <small>The tool also returned non-text content.</small>
        )}
        {item.success === false && <small>Tool reported a failure.</small>}
        {item.durationMs !== null && <small>Duration {item.durationMs} ms</small>}
      </details>
    );
  }
  if (item.type === 'mcpToolCall')
    return (
      <details className="agent-activity">
        <summary>
          <code>
            {item.server}.{item.tool}
          </code>{' '}
          · {item.status}
        </summary>
        {toolInput(item.arguments) && (
          <pre aria-label="Tool input">{toolInput(item.arguments)}</pre>
        )}
        {item.result && (
          <pre aria-label="Tool output">
            {toolContent(item.result.content) || 'No text output.'}
          </pre>
        )}
        {item.result?.structuredContent != null && (
          <pre aria-label="Structured result">{toolContent(item.result.structuredContent)}</pre>
        )}
        {item.error && <p className="agent-tool-error">{item.error.message}</p>}
        {!item.result && !item.error && (
          <p>{item.status === 'inProgress' ? 'Waiting for output…' : 'No output.'}</p>
        )}
      </details>
    );
  if (item.type === 'functionCallOutput')
    return (
      <details className="agent-activity">
        <summary>
          <code>{[item.namespace, item.name].filter(Boolean).join('.')}</code>
        </summary>
        <pre aria-label="Tool output">{toolContent(item.output) || 'No text output.'}</pre>
      </details>
    );
  if (item.type === 'webSearch') {
    const action = item.action;
    const label =
      action?.type === 'openPage'
        ? 'Open page'
        : action?.type === 'findInPage'
          ? 'Find on page'
          : 'Search web';
    const input =
      action?.type === 'search'
        ? action.queries?.join('\n') || action.query || item.query
        : action?.type === 'openPage'
          ? action.url || item.query
          : action?.type === 'findInPage'
            ? [action.url, action.pattern].filter(Boolean).join('\n')
            : item.query;
    return (
      <details className="agent-activity">
        <summary>
          {label}
          {input && (
            <>
              {' '}
              · <span>{input.split('\n')[0]}</span>
            </>
          )}
        </summary>
        {input && <pre aria-label="Search input">{input}</pre>}
        {item.results?.length ? (
          <pre aria-label="Search results">{toolContent(item.results)}</pre>
        ) : null}
      </details>
    );
  }
  if (item.type === 'collabAgentToolCall') {
    const labels: Record<typeof item.tool, string> = {
      spawnAgent: 'Start agent',
      sendInput: 'Guide agent',
      resumeAgent: 'Resume agent',
      wait: 'Wait for agents',
      closeAgent: 'Close agent',
      sendMessage: 'Message agent',
      followupTask: 'Follow-up task',
      interruptAgent: 'Stop agent',
      listAgents: 'List agents',
    };
    return (
      <details className="agent-activity">
        <summary>
          {labels[item.tool]} · {item.status}
        </summary>
        {item.prompt && <pre>{item.prompt}</pre>}
        {Object.entries(item.agentsStates || {}).map(
          ([id, state]) =>
            state && (
              <div key={id}>
                <small>
                  Agent {id} · {state.status}
                </small>
                {state.message && <pre>{state.message}</pre>}
              </div>
            ),
        )}
      </details>
    );
  }
  if (item.type === 'subAgentActivity')
    return (
      <details className="agent-activity">
        <summary>Agent activity · {item.kind}</summary>
        <p>{item.agentPath}</p>
      </details>
    );
  if (item.type === 'imageView')
    return (
      <details className="agent-activity">
        <summary>
          View image · <code>{item.path}</code>
        </summary>
        <p>{item.path}</p>
      </details>
    );
  if (item.type === 'imageGeneration')
    return (
      <details className="agent-activity">
        <summary>Generate image · {item.status}</summary>
        {item.revisedPrompt && <pre>{item.revisedPrompt}</pre>}
        {item.savedPath && <p>{item.savedPath}</p>}
        {item.failure && <p className="agent-tool-error">Image generation limit reached.</p>}
        {item.result &&
          (/^[A-Za-z0-9+/=\r\n]+$/.test(item.result) ? (
            <img
              className="agent-generated-image"
              src={'data:image/png;base64,' + item.result}
              alt="Generated image"
            />
          ) : (
            <pre>{item.result}</pre>
          ))}
      </details>
    );
  if (item.type === 'sleep')
    return (
      <details className="agent-activity">
        <summary>Wait · {item.durationMs / 1000} seconds</summary>
        <p>Paused for {item.durationMs / 1000} seconds.</p>
      </details>
    );
  return (
    <details className="agent-activity">
      <summary>{activityName(item.type)}</summary>
      <pre>{JSON.stringify(item, null, 2)}</pre>
    </details>
  );
}
