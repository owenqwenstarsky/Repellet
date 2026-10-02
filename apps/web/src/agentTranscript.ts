import type { Thread, ThreadItem } from '@repellet/codex-protocol';
import type { AgentSnapshot } from '@repellet/shared';
import { isToolItem } from './toolActivity';

export type AgentTranscriptEntry = { key: string; turnId: string; item: ThreadItem };

export function groupAgentTools(entries: AgentTranscriptEntry[]) {
  const groups: Array<
    | { type: 'item'; key: string; entry: AgentTranscriptEntry }
    | { type: 'tools'; key: string; entries: AgentTranscriptEntry[] }
  > = [];
  for (let index = 0; index < entries.length;) {
    const first = entries[index]!;
    const run = [first];
    index++;
    if (isToolItem(first.item))
      while (
        index < entries.length &&
        entries[index]!.turnId === first.turnId &&
        isToolItem(entries[index]!.item)
      )
        run.push(entries[index++]!);
    if (run.length > 3) groups.push({ type: 'tools', key: 'tools:' + first.key, entries: run });
    else for (const entry of run) groups.push({ type: 'item', key: entry.key, entry });
  }
  return groups;
}

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

/** Merge the bounded live projection into saved history by turn and shared anchors.
 * Legacy messages have synthetic IDs, so match their occurrences by content.
 */
export function agentTranscript(
  threadId: string,
  history: Thread | null,
  live: AgentSnapshot['items'],
) {
  const turns = new Map<string, { stored: ThreadItem[]; live: ThreadItem[] }>();
  if (history?.id === threadId)
    for (const turn of history.turns) turns.set(turn.id, { stored: turn.items, live: [] });
  for (const entry of live) {
    if (entry.threadId !== threadId) continue;
    let turn = turns.get(entry.turnId);
    if (!turn) {
      turn = { stored: [], live: [] };
      turns.set(entry.turnId, turn);
    }
    turn.live.push(entry.item);
  }
  return [...turns].flatMap(([turnId, turn]) => {
    const used = new Set<number>();
    const matches = turn.live.map((item) => {
      let index = turn.stored.findIndex(
        (stored, index) => !used.has(index) && stored.id === item.id,
      );
      const key = messageKey(item);
      if (index === -1 && key !== null)
        index = turn.stored.findIndex(
          (stored, index) => !used.has(index) && messageKey(stored) === key,
        );
      if (index !== -1) used.add(index);
      return index;
    });
    const items = turn.stored.map((item) => ({ key: turnId + ':' + item.id, turnId, item }));
    const additions = new Map<number, typeof items>();
    let previous = -1;
    turn.live.forEach((item, index) => {
      const match = matches[index]!;
      if (match !== -1) {
        // Retain the saved key even when Codex's live message ID is different.
        items[match] = { key: items[match]!.key, turnId, item };
        previous = match;
        return;
      }
      const next = matches.slice(index + 1).find((match) => match !== -1);
      const at = next ?? (previous === -1 ? items.length : previous + 1);
      const entries = additions.get(at) || [];
      entries.push({ key: turnId + ':' + item.id, turnId, item });
      additions.set(at, entries);
    });
    return items
      .flatMap((item, index) => [...(additions.get(index) || []), item])
      .concat(additions.get(items.length) || []);
  });
}
