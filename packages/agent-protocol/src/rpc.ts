import type { Model, Thread, ThreadItem, Turn } from './index.js';

/** Public operations exposed by the Repellet agent adapter. */
export type AgentMethod =
  | 'thread/list'
  | 'thread/read'
  | 'thread/start'
  | 'thread/name/set'
  | 'thread/archive'
  | 'thread/unarchive'
  | 'thread/fork'
  | 'thread/plan/toggle'
  | 'turn/start'
  | 'turn/steer'
  | 'turn/interrupt'
  | 'model/list'
  | 'question/respond';
export type AgentThread = Thread;
export type AgentTurn = Turn;
export type AgentItem = ThreadItem;
export type AgentModel = Model;
export type AgentRpcRequest = {
  generation: string;
  method: AgentMethod;
  params: Record<string, unknown>;
};
export type AgentRpcResult = {
  thread?: AgentThread;
  turn?: AgentTurn;
  data?: unknown;
  ok?: boolean;
};
