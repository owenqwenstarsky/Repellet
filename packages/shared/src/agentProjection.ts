import type { AgentEvent, AgentSnapshot } from './agent.js';
export function projectAgentEvent(previous: AgentSnapshot, message: AgentEvent): AgentSnapshot {
  if (message.type === 'snapshot') return message.snapshot;
  if (message.generation !== previous.generation || message.sequence <= previous.sequence)
    return previous;
  const state: AgentSnapshot = {
    ...previous,
    sequence: message.sequence,
    pending: [...previous.pending],
    items: previous.items.map((entry) => ({ ...entry, item: { ...entry.item } })),
  };
  if (message.type === 'process/error') {
    return {
      ...state,
      error: message.message,
      connected: false,
      active: null,
      compacting: false,
      pending: [],
      waiting: false,
    };
  }
  if (message.type === 'question') state.pending.push(message.question);
  if (message.type === 'compaction') state.compacting = message.active;
  if (message.type === 'question/resolved')
    state.pending = state.pending.filter((question) => question.id !== message.requestId);
  if (message.type === 'event') {
    const { method } = message.event;
    const params = message.event.params as any;
    if (method === 'turn/started') {
      state.active = { threadId: params.threadId, turnId: params.turn.id };
      state.error = null;
    }
    if (method === 'turn/completed') {
      if (state.active?.turnId === params.turn.id) state.active = null;
      state.pending = state.pending.filter((question) => question.params.turnId !== params.turn.id);
      state.error = params.turn.error?.message || null;
      for (const item of params.turn.items || []) upsert(params.threadId, params.turn.id, item);
    }
    if (method === 'serverRequest/resolved')
      state.pending = state.pending.filter((question) => question.id !== params.requestId);
    if (method === 'item/started' || method === 'item/completed')
      upsert(params.threadId, params.turnId, params.item);
    if (method === 'error')
      state.error = params.error?.message || 'Agent failed. Retry after checking your provider.';
    const deltaFields: Record<string, string> = {
      'item/agentMessage/delta': 'text',
      'item/plan/delta': 'text',
      'item/commandExecution/outputDelta': 'aggregatedOutput',
    };
    const field = deltaFields[method];
    if (field) {
      const entry = state.items.find(
        (entry) => entry.threadId === params.threadId && entry.item.id === params.itemId,
      );
      if (entry)
        (entry.item as any)[field] = (
          String((entry.item as any)[field] || '') + params.delta
        ).slice(-512000);
    }
  }
  state.waiting = state.pending.some((question) => question.params.isBlocking);
  state.items = state.items.slice(-500);
  // Bounded reconnect projection; Pi remains the source of persisted history.
  let characters = 0;
  state.items = state.items
    .reverse()
    .filter((entry) => {
      characters += JSON.stringify(entry).length;
      return characters <= 1000000;
    })
    .reverse();
  return state;
  function upsert(threadId: string, turnId: string, item: any) {
    const index = state.items.findIndex(
      (entry) => entry.threadId === threadId && entry.item.id === item.id,
    );
    const entry = { threadId, turnId, item: bound(item) };
    function bound(value: any): any {
      if (typeof value === 'string')
        return value.length > 64000
          ? value.slice(0, 64000) + '\n[Activity truncated; read the saved conversation for more.]'
          : value;
      if (Array.isArray(value)) return value.slice(0, 200).map(bound);
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, bound(value)]));
      return value;
    }
    if (index === -1) state.items.push(entry);
    else state.items[index] = entry;
  }
}
