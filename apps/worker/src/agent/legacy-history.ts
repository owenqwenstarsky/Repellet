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
  const calls = new Map<string, { turnId: string; name: string; args: string; output?: string }>();
  let turnId = '';
  for (const line of contents.split('\n')) {
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
    if (record.type !== 'response_item' || !turnId || typeof item.call_id !== 'string') continue;
    if (
      ['function_call', 'custom_tool_call'].includes(item.type) &&
      typeof item.name === 'string'
    ) {
      const args = item.arguments ?? item.input;
      if (typeof args === 'string') calls.set(item.call_id, { turnId, name: item.name, args });
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
        let args: any = {};
        try {
          args = JSON.parse(call.args);
        } catch {}
        const command = args.cmd ?? args.command;
        // Unknown custom models invoke Codex's patch tool through unified exec.
        // Only recognize the direct apply_patch heredoc form, never arbitrary output.
        const patch =
          call.name === 'apply_patch'
            ? typeof args.patch === 'string'
              ? args.patch
              : typeof args.input === 'string'
                ? args.input
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
            cwd: typeof args.workdir === 'string' ? args.workdir : thread.cwd,
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
      const firstAgent = turn.items.findIndex((item) => item.type === 'agentMessage');
      const at = firstAgent === -1 ? turn.items.length : firstAgent;
      return { ...turn, items: [...turn.items.slice(0, at), ...tools, ...turn.items.slice(at)] };
    }),
  };
}
