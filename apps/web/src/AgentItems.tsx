import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, FileCode2 } from 'lucide-react';
import type { ThreadItem } from '@repellet/agent-protocol';
import { Button } from './ui';
import { groupAgentTools, type AgentTranscriptEntry } from './agentTranscript';
import {
  activityName,
  toolCategory,
  toolContent,
  toolFailed,
  toolArguments,
  toolInput,
  toolLabel,
  toolOutput,
  isShortToolText,
  workspaceFilePath,
} from './toolActivity';

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        img: () => null,
        input: ({ checked, ...props }) => <input {...props} checked={checked} disabled />,
        a: ({ href, children }) => {
          const safe = href && /^(?:https?:|mailto:)/i.test(href) ? href : null;
          return safe ? (
            <a href={safe} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function FileAction({ path, onOpenFile }: { path: string; onOpenFile: (path: string) => void }) {
  return (
    <Button
      variant="link"
      size="sm"
      icon={<FileCode2 size={13} aria-hidden="true" />}
      title={`Open file ${path}`}
      aria-label={path}
      onClick={() => onOpenFile(path)}
    >
      {path}
    </Button>
  );
}

function ToolText({ label, value }: { label: string; value: string }) {
  if (isShortToolText(value))
    return (
      <pre aria-label={label} className="agent-tool-text">
        {value}
      </pre>
    );
  return (
    <details className="agent-tool-text-details">
      <summary>
        {label} · {value.length.toLocaleString()} characters
      </summary>
      <pre aria-label={label} className="agent-tool-text">
        {value}
      </pre>
    </details>
  );
}

function PlanContent({ text }: { text: string }) {
  const blocks: Array<
    { type: 'markdown'; text: string } | { type: 'todo'; done: boolean; id?: string; text: string }
  > = [];
  let markdown: string[] = [];
  const flush = () => {
    if (markdown.length) blocks.push({ type: 'markdown', text: markdown.join('\n') });
    markdown = [];
  };
  for (const line of text.split('\n')) {
    const match = line.match(/^\[([ xX])\]\s*(?:#(\d+)[:.]?\s*)?(.*)$/);
    if (!match) {
      markdown.push(line);
      continue;
    }
    flush();
    blocks.push({
      type: 'todo',
      done: match[1].toLowerCase() === 'x',
      id: match[2],
      text: match[3] || '',
    });
  }
  flush();
  return (
    <div className="agent-plan-content">
      {blocks.map((block, index) => {
        if (block.type === 'markdown') return <Markdown key={index}>{block.text}</Markdown>;
        return (
          <label className="agent-todo" key={index}>
            <input type="checkbox" disabled checked={block.done} />
            <span>{block.id ? `#${block.id}: ` : ''}</span>
            <Markdown>{block.text}</Markdown>
          </label>
        );
      })}
    </div>
  );
}

function dynamicOutput(item: Extract<ThreadItem, { type: 'dynamicToolCall' }>): string {
  return (
    item.contentItems
      ?.filter((content) => content.type === 'inputText')
      .map((content) => toolOutput(content.text))
      .join('\n') || ''
  );
}

function normalizedDiff(args: Record<string, unknown>, output: string): string {
  const oldText = args.oldText ?? args.old_string ?? args.old;
  const newText = args.newText ?? args.new_string ?? args.new;
  if (typeof oldText === 'string' && typeof newText === 'string') return `-${oldText}\n+${newText}`;
  return output;
}

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
  if (item.type === 'agentMessage')
    return (
      <article className={`agent-item ${item.type}`}>
        <Markdown>{item.text}</Markdown>
      </article>
    );
  if (item.type === 'plan')
    return (
      <article className="agent-item plan">
        {item.text ? <PlanContent text={item.text} /> : <p>{item.summary || 'Plan updated'}</p>}
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
      <details className="agent-activity" open={isShortToolText(item.aggregatedOutput)}>
        <summary>
          <code>{item.command}</code> · {item.status}
        </summary>
        <ToolText
          label="Tool output"
          value={
            item.aggregatedOutput ||
            (item.status === 'inProgress' ? 'Waiting for output…' : 'No output.')
          }
        />
        {item.exitCode !== null && <small>Exit code {item.exitCode}</small>}
      </details>
    );
  if (item.type === 'fileChange')
    return (
      <details className="agent-activity" open>
        <summary>File changes · {item.status}</summary>
        {item.changes.map((change, index) => {
          const path = workspaceFilePath(change.path);
          return (
            <div key={index}>
              {path ? (
                <FileAction path={path} onOpenFile={onOpenFile} />
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
          <Markdown key={index}>{text}</Markdown>
        ))}
      </details>
    );
  if (item.type === 'dynamicToolCall') {
    const input = toolInput(item.arguments);
    const output = dynamicOutput(item);
    const args = toolArguments(item.arguments);
    const name = item.tool;
    const path = workspaceFilePath(
      args.path ?? args.file ?? args.filename ?? args.filePath ?? args.file_path,
    );
    const structured = ['write', 'read', 'edit', 'grep', 'find', 'ls'].includes(name);
    const planTool =
      ['plan', 'plan_read', 'plan_edit', 'todo_edit'].includes(name) &&
      item.status !== 'failed' &&
      item.success !== false;
    const range =
      name === 'read'
        ? [
            args.startLine ?? args.start_line ?? args.lineStart ?? args.offset,
            args.endLine ?? args.end_line ?? args.lineEnd ?? args.limit,
          ]
            .filter((value) => value !== undefined)
            .join('–')
        : '';
    const content = typeof args.content === 'string' ? args.content : '';
    const editDiff = name === 'edit' ? normalizedDiff(args, output) : output;
    const concise =
      name === 'write'
        ? 'Writing file'
        : name === 'read'
          ? `Reading${range ? ` lines ${range}` : ''}`
          : name === 'edit'
            ? 'Applying edit'
            : name === 'grep'
              ? `Searching${typeof args.pattern === 'string' ? ` for ${args.pattern}` : ''}`
              : name === 'find'
                ? 'Finding files'
                : name === 'ls'
                  ? 'Listing files'
                  : '';
    return (
      <details
        className="agent-activity"
        open={!!(structured && (isShortToolText(output) || isShortToolText(content)))}
      >
        <summary>
          <span>
            {structured || planTool ? (
              toolLabel(name)
            ) : (
              <code>{[item.namespace, name].filter(Boolean).join('.')}</code>
            )}
          </span>{' '}
          · {item.status}
        </summary>
        {planTool && output && <PlanContent text={output} />}
        {structured && concise && <p className="agent-tool-label">{concise}</p>}
        {path ? (
          <FileAction path={path} onOpenFile={onOpenFile} />
        ) : args.path ? (
          <span>{String(args.path)}</span>
        ) : null}
        {name === 'write' && content && <ToolText label="Content preview" value={content} />}
        {name === 'edit' && editDiff && <ToolText label="Edit diff" value={editDiff} />}
        {name === 'read' && output && <ToolText label="Tool output" value={output} />}
        {['grep', 'find', 'ls'].includes(name) && output && (
          <ToolText label="Tool output" value={output} />
        )}
        {!structured && !planTool && input && (
          <>
            <small>
              {name === 'exec' && typeof item.arguments === 'string' ? 'Script' : 'Input'}
            </small>
            <ToolText label="Tool input" value={input} />
          </>
        )}
        {!structured && !planTool && (
          <ToolText
            label="Tool output"
            value={
              output || (item.status === 'inProgress' ? 'Waiting for output…' : 'No text output.')
            }
          />
        )}
        {item.contentItems?.some((content) => content.type !== 'inputText') && (
          <small>The tool also returned non-text content.</small>
        )}
        {item.success === false && <small>Tool reported a failure.</small>}
        {item.durationMs !== null && <small>Duration {item.durationMs} ms</small>}
      </details>
    );
  }
  if (item.type === 'mcpToolCall')
    return (() => {
      const resultText = item.result ? toolContent(item.result.content) : '';
      const inputText = toolInput(item.arguments);
      return (
        <details
          className="agent-activity"
          open={isShortToolText(resultText) && isShortToolText(inputText)}
        >
          <summary>
            <code>
              {item.server}.{item.tool}
            </code>{' '}
            · {item.status}
          </summary>
          {inputText && <ToolText label="Tool input" value={inputText} />}
          {item.result && <ToolText label="Tool output" value={resultText || 'No text output.'} />}
          {item.result?.structuredContent != null && (
            <ToolText
              label="Structured result"
              value={toolContent(item.result.structuredContent)}
            />
          )}
          {item.error && <p className="agent-tool-error">{item.error.message}</p>}
          {!item.result && !item.error && (
            <p>{item.status === 'inProgress' ? 'Waiting for output…' : 'No output.'}</p>
          )}
        </details>
      );
    })();
  if (item.type === 'functionCallOutput')
    return (() => {
      const output = toolContent(item.output) || 'No text output.';
      return (
        <details className="agent-activity" open={isShortToolText(output)}>
          <summary>
            <code>{[item.namespace, item.name].filter(Boolean).join('.')}</code>
          </summary>
          <ToolText label="Tool output" value={output} />
        </details>
      );
    })();
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
