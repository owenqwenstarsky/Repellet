import path from 'node:path';
import type { Thread, ThreadItem } from '@repellet/codex-protocol';
type FileUpdateChange = Extract<ThreadItem, { type: 'fileChange' }>['changes'][number];
import type { CodexConnection } from './connection.js';

/** Codex 0.160.0 persists tool records but omits them from legacy thread/read.
 * Read only the server-selected private rollout, never a client-supplied path.
 * This is a read-only projection; Codex remains the sole history writer.
 */
export async function hydrateLegacyTools(connection: CodexConnection, thread: Thread) {
  if (!thread.path || thread.historyMode !== 'legacy' || !thread.turns.length) return thread;
  const rollout = path.posix.normalize(thread.path);
  if (!/^\/home\/agent\/\.codex\/(sessions|archived_sessions)\/.+\.jsonl$/.test(rollout))
    throw new Error('Codex returned an incompatible history location. Reopen the conversation.');
  const data = await connection.call('fs/readFile', { path: rollout });
  return projectLegacyTools(thread, Buffer.from(data.dataBase64, 'base64').toString('utf8'));
}

export function projectLegacyTools(thread: Thread, contents: string): Thread {
  const calls = new Map<
    string,
    { turnId: string; name: string; args: string; position: number; output?: string }
  >();
  const positions = new Map<string, Map<string, number>>();
  let turnId = '';
  let position = 0;
  for (const line of contents.split('\n')) {
    position++;
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    } // An active rollout may end mid-write.
    const item = record.payload;
    if (!item || typeof item !== 'object') continue;
    if (
      (record.type === 'turn_context' ||
        (record.type === 'event_msg' && item.type === 'task_started')) &&
      typeof item.turn_id === 'string'
    )
      turnId = item.turn_id;
    if (record.type === 'event_msg' && turnId) {
      // Match occurrences to the messages returned by Codex, which gives legacy
      // messages synthetic IDs. Only use events as ordering anchors, never as
      // another source of transcript content (including model instructions).
      const type =
        item.type === 'agent_message'
          ? 'agentMessage'
          : item.type === 'user_message'
            ? 'userMessage'
            : null;
      const turn = thread.turns.find((turn) => turn.id === turnId);
      if (type && turn && typeof item.message === 'string') {
        const order = positions.get(turnId) || new Map<string, number>();
        positions.set(turnId, order);
        const message = turn.items.find(
          (entry) =>
            !order.has(entry.id) &&
            entry.type === type &&
            (entry.type === 'agentMessage'
              ? entry.text
              : entry.type === 'userMessage'
                ? entry.content
                    .filter((content) => content.type === 'text')
                    .map((content) => content.text)
                    .join('\n')
                : null) === item.message,
        );
        if (message) order.set(message.id, position);
      }
    }
    if (record.type !== 'response_item' || !turnId || typeof item.call_id !== 'string') continue;
    if (
      ['function_call', 'custom_tool_call'].includes(item.type) &&
      typeof item.name === 'string'
    ) {
      const args = item.arguments ?? item.input;
      if (typeof args === 'string' && !calls.has(item.call_id))
        calls.set(item.call_id, { turnId, name: item.name, args, position });
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const call = calls.get(item.call_id);
      if (call)
        call.output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
    }
  }
  return {
    ...thread,
    turns: thread.turns.map((turn) => {
      const tools: ThreadItem[] = [];
      const existing = new Set(turn.items.map((item) => item.id));
      for (const [id, call] of calls) {
        if (call.turnId !== turn.id || existing.has(id)) continue;
        let args: any;
        try {
          args = JSON.parse(call.args);
        } catch {
          // Custom tools such as exec accept source code rather than JSON.
          // Preserve that input so saved activity can display the original script.
          args = call.args;
        }
        const fields = args && typeof args === 'object' ? args : {};
        const command = fields.cmd ?? fields.command;
        // Unknown custom models invoke Codex's patch tool through unified exec.
        // Only recognize the direct apply_patch heredoc form, never arbitrary output.
        const patch =
          call.name === 'apply_patch'
            ? typeof fields.patch === 'string'
              ? fields.patch
              : typeof fields.input === 'string'
                ? fields.input
                : call.args
            : typeof command === 'string' && /^\s*apply_patch\s+<</.test(command)
              ? (command.match(/\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch/)?.[0] ?? null)
              : null;
        if (patch !== null) {
          const changes: FileUpdateChange[] = [];
          const sections = patch.split(/(?=\*\*\* (?:Add|Update|Delete) File: )/);
          for (const section of sections) {
            const match = section.match(/^\*\*\* (Add|Update|Delete) File: ([^\n]+)\n?/);
            if (!match) continue;
            const move = section.match(/^\*\*\* Move to: ([^\n]+)/m);
            changes.push({
              path: match[2]!,
              kind:
                match[1] === 'Add'
                  ? { type: 'add' }
                  : match[1] === 'Delete'
                    ? { type: 'delete' }
                    : { type: 'update', move_path: move?.[1] ?? null },
              diff: section.slice(match[0].length).replace(/\*\*\* End Patch\s*$/, ''),
            });
          }
          if (changes.length)
            tools.push({
              type: 'fileChange',
              id,
              changes,
              status: call.output?.includes('Success') ? 'completed' : 'failed',
            });
        } else if (['exec_command', 'shell', 'shell_command'].includes(call.name)) {
          if (typeof command !== 'string' && !Array.isArray(command)) continue;
          const output = call.output ?? null;
          const code = output?.match(/(?:Process exited with code|"exit_code"\s*:)\s*(-?\d+)/);
          tools.push({
            type: 'commandExecution',
            id,
            command: Array.isArray(command) ? command.join(' ') : command,
            cwd: typeof fields.workdir === 'string' ? fields.workdir : thread.cwd,
            pluginId: null,
            scriptPath: null,
            processId: null,
            source: 'agent',
            status:
              output !== null
                ? 'completed'
                : turn.status === 'inProgress'
                  ? 'inProgress'
                  : 'failed',
            commandActions: [],
            aggregatedOutput: output,
            exitCode: code ? Number(code[1]) : null,
            durationMs: null,
          });
        } else {
          tools.push({
            type: 'dynamicToolCall',
            id,
            namespace: null,
            tool: call.name,
            arguments: args,
            status: call.output !== undefined ? 'completed' : 'failed',
            contentItems:
              call.output !== undefined ? [{ type: 'inputText', text: call.output }] : null,
            success: null,
            durationMs: null,
          });
        }
      }
      // Messages are supplied by Codex's supported thread API. Never project instructions,
      // credentials, encrypted reasoning, or model context from the rollout.
      const order = positions.get(turn.id) || new Map<string, number>();
      for (const [id, call] of calls) if (call.turnId === turn.id) order.set(id, call.position);
      const firstAgent = turn.items.findIndex((item) => item.type === 'agentMessage');
      const at = firstAgent === -1 ? turn.items.length : firstAgent;
      const ranked = turn.items.map((item, index) => {
        let rank = order.get(item.id);
        if (rank === undefined) {
          // Keep API-only items in their original relative order, before their
          // next saved anchor. An incomplete rollout may not have their event yet.
          const next = turn.items.slice(index + 1).find((entry) => order.has(entry.id));
          rank = next
            ? order.get(next.id)! - (turn.items.length - index) / (turn.items.length + 1)
            : index < at && !turn.items.some((entry) => order.has(entry.id))
              ? -1 + index / (turn.items.length + 1)
              : position + index;
        }
        return { item, rank };
      });
      for (const item of tools) ranked.push({ item, rank: order.get(item.id)! });
      ranked.sort((a, b) => a.rank - b.rank);
      return { ...turn, items: ranked.map(({ item }) => item) };
    }),
  };
}
