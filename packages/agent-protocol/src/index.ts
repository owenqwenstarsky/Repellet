/** Repellet-owned transport and conversation types. No provider protocol crosses this boundary. */
import type { ThreadItem } from './items.js';
export type { ThreadItem } from './items.js';
export type ThreadId = string;
export type Turn = {
  id: string;
  items: ThreadItem[];
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  itemsView: 'full' | 'streaming' | 'summary';
  error: { message: string } | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};
export type Thread = {
  id: string;
  name: string | null;
  preview: string;
  parentThreadId: string | null;
  forkedFromId: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt: number;
  turns: Turn[];
  cwd: string;
  modelProvider: string;
  model?: string | null;
  planMode?: boolean;
  path: string | null;
  [metadata: string]: unknown;
};
export type Model = {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string | null;
};
export type LoginAccountResponse = {
  type: 'chatgptDeviceCode';
  loginId: string;
  verificationUrl: string;
  userCode: string;
};
export type GetAccountResponse = {
  account: { type: 'chatgpt'; email?: string; planType?: string; authMode?: string } | null;
};
export type ChatgptAuthTokensRefreshResponse = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};
export type ToolRequestUserInputParams = {
  threadId: string;
  turnId: string;
  itemId: string;
  isBlocking: boolean;
  autoResolutionMs?: number | null;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isSecret?: boolean;
    isOther?: boolean;
    options?: Array<{
      label: string;
      description: string;
      textInput?: { placeholder: string };
    }> | null;
  }>;
};
export type ToolRequestUserInputResponse = { answers: Record<string, { answers: string[] }> };
export type ServerRequest =
  | {
      method: 'repellet/resource/control';
      id: string | number;
      params: {
        threadId: string;
        turnId: string;
        operation: string;
        arguments: Record<string, unknown>;
      };
    }
  | {
      id: string | number;
      method: 'repellet/project/control';
      params: import('./project-control.js').ProjectControlRequest;
    }
  | {
      id: string | number;
      method: 'account/chatgptAuthTokens/refresh';
      params: { previousAccountId?: string | null };
    }
  | {
      id: string | number;
      method: 'item/tool/requestUserInput';
      params: ToolRequestUserInputParams;
    }
  | { id: string | number; method: 'currentTime/read'; params: Record<string, unknown> };
export type ServerNotification =
  | { method: 'account/login/completed'; params: { loginId: string; success: boolean } }
  | { method: 'thread/started'; params: { thread: Thread } }
  | { method: 'thread/name/updated'; params: { threadId: string; name: string } }
  | { method: 'thread/planMode/updated'; params: { threadId: string; enabled: boolean } }
  | { method: 'thread/archived' | 'thread/unarchived'; params: { threadId: string } }
  | { method: 'turn/started' | 'turn/completed'; params: { threadId: string; turn: Turn } }
  | {
      method: 'item/started' | 'item/completed';
      params: { threadId: string; turnId: string; item: ThreadItem };
    }
  | {
      method: 'item/agentMessage/delta' | 'item/commandExecution/outputDelta';
      params: { threadId: string; turnId: string; itemId: string; delta: string };
    }
  | { method: 'serverRequest/resolved'; params: { requestId: string | number } }
  | { method: 'error'; params: { error: { message: string } } };
export type ClientRequest = {
  id?: string | number;
  method:
    | import('./rpc.js').AgentMethod
    | 'initialize'
    | 'initialized'
    | 'account/read'
    | 'account/login/start'
    | 'account/login/cancel'
    | 'account/logout'
    | 'thread/resume'
    | 'thread/compact/start';
  params: Record<string, unknown>;
};
export * from './rpc.js';
export * from './project-control.js';

export * from './resource-control.js';
