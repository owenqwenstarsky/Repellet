/** Unwrap Codex tool-result envelopes without interpreting or executing their contents. */
export function toolOutput(text: string): string {
  function unwrap(value: unknown, depth: number): string | null {
    if (depth > 6) return null;
    if (typeof value === 'string') {
      try {
        return unwrap(JSON.parse(value), depth + 1) ?? value;
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) {
      const parts = value.map((entry) => {
        if (
          !entry ||
          typeof entry !== 'object' ||
          !['input_text', 'inputText', 'text'].includes(entry.type) ||
          typeof entry.text !== 'string'
        )
          return null;
        return unwrap(entry.text, depth + 1);
      });
      return parts.every((part) => part !== null) ? parts.join('\n') : null;
    }
    if (
      value &&
      typeof value === 'object' &&
      'output' in value &&
      typeof value.output === 'string' &&
      ('chunk_id' in value || 'exit_code' in value || 'wall_time_seconds' in value)
    ) {
      const output = unwrap(value.output, depth + 1) ?? value.output;
      const code = 'exit_code' in value ? value.exit_code : null;
      return [output || 'No output.', typeof code === 'number' ? `Exit code ${code}` : null]
        .filter((part) => part !== null)
        .join('\n');
    }
    return null;
  }
  return unwrap(text, 0) ?? text;
}

export function toolInput(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && Object.keys(value).length === 0) return null;
  return JSON.stringify(value, null, 2);
}
import type { ThreadItem } from '@repellet/codex-protocol';

export function isToolItem(item: ThreadItem): boolean {
  return (
    [
      'commandExecution',
      'fileChange',
      'dynamicToolCall',
      'mcpToolCall',
      'functionCallOutput',
      'collabAgentToolCall',
      'subAgentActivity',
      'webSearch',
      'imageView',
      'imageGeneration',
      'sleep',
    ].includes(item.type) || /ToolCall$/.test(item.type)
  );
}

export function toolCategory(item: ThreadItem): string {
  switch (item.type) {
    case 'commandExecution':
      return 'Commands';
    case 'fileChange':
      return 'Files';
    case 'webSearch':
      return 'Web';
    case 'mcpToolCall':
      return item.server;
    case 'dynamicToolCall':
      return [item.namespace, item.tool].filter(Boolean).join('.');
    case 'functionCallOutput':
      return item.name;
    case 'collabAgentToolCall':
    case 'subAgentActivity':
      return 'Agents';
    case 'imageView':
    case 'imageGeneration':
      return 'Images';
    case 'sleep':
      return 'Wait';
    default:
      return activityName(item.type);
  }
}

export function activityName(type: string): string {
  const text = type.replace(/([a-z])([A-Z])/g, '$1 $2');
  return text[0]!.toUpperCase() + text.slice(1);
}

export function toolFailed(item: ThreadItem): boolean {
  return (
    ('status' in item && item.status === 'failed') ||
    ('success' in item && item.success === false) ||
    (item.type === 'commandExecution' &&
      item.exitCode !== null &&
      item.exitCode !== undefined &&
      item.exitCode !== 0) ||
    (item.type === 'mcpToolCall' && item.error !== null) ||
    (item.type === 'imageGeneration' && item.failure !== null)
  );
}

/** Read text blocks from MCP and function results; preserve unfamiliar result shapes. */
export function toolContent(content: unknown): string {
  if (typeof content === 'string') return toolOutput(content);
  if (Array.isArray(content)) return content.map(toolContent).filter(Boolean).join('\n');
  if (content && typeof content === 'object') {
    if ('type' in content && content.type === 'encrypted_content') return 'Encrypted result';
    if ('text' in content && typeof content.text === 'string') return toolOutput(content.text);
    if (
      'type' in content &&
      ['image', 'audio', 'input_image', 'input_audio'].includes(String(content.type))
    )
      return `${activityName(String(content.type).replace('input_', ''))} returned`;
  }
  return toolInput(content) || '';
}
