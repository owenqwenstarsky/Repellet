/** Repellet transcript item shapes. Historical activity remains renderable after import. */
export type ImageDetail = 'auto' | 'low' | 'high' | 'original';
export type FunctionCallOutputContentItem =
  | { type: 'input_text'; text: string }
  | ({ type: 'input_image'; detail?: ImageDetail } & ({ image_url: string } | { file_id: string }))
  | { type: 'input_audio'; audio_url: string }
  | { type: 'encrypted_content'; encrypted_content: string };
export type FunctionCallOutputBody = string | Array<FunctionCallOutputContentItem>;
export type AbsolutePathBuf = string;
export type ImageGenerationFailure = {
  type: 'usageLimitExceeded';
  limitId: string;
  resetsAt: number | null;
};
export type ImageGenerationItem = {
  id: string;
  status: string;
  revisedPrompt: string | null;
  result: string;
  transparentBackground?: boolean;
  failure: ImageGenerationFailure | null;
  savedPath?: AbsolutePathBuf;
};
export type LegacyAppPathString = string;
export type MessagePhase = 'commentary' | 'final_answer';
export type ReasoningEffort = string;
export type SleepItem = { id: string; durationMs: number };
export type JsonValue =
  number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;
export type WebSearchAction =
  | { type: 'search'; query: string | null; queries: Array<string> | null }
  | { type: 'openPage'; url: string | null }
  | { type: 'findInPage'; url: string | null; pattern: string | null }
  | { type: 'other' };
export type WebSearchItem = {
  id: string;
  query: string;
  action: WebSearchAction | null;

  results: Array<JsonValue> | null;
};
export type AgentMessageDelivery = 'async';
export type AsyncUserInputQuestion = { title: string; options: Array<string> | null };
export type CollabAgentStatus =
  'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound';
export type CollabAgentState = { status: CollabAgentStatus; message: string | null };
export type CollabAgentTool =
  | 'spawnAgent'
  | 'sendInput'
  | 'resumeAgent'
  | 'wait'
  | 'closeAgent'
  | 'sendMessage'
  | 'followupTask'
  | 'interruptAgent'
  | 'listAgents';
export type CollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';
export type CommandAction =
  | { type: 'read'; command: string; name: string; path: LegacyAppPathString }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string };
export type CommandExecutionSource =
  'agent' | 'userShell' | 'unifiedExecStartup' | 'unifiedExecInteraction';
export type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string };
export type DynamicToolCallStatus = 'inProgress' | 'completed' | 'failed';
export type PatchChangeKind =
  { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
export type FileUpdateChange = { path: string; kind: PatchChangeKind; diff: string };
export type HookPromptFragment = { text: string; hookRunId: string };
export type McpAppDisplayMode = 'inline' | 'fullscreen';
export type McpAppUi = { resourceUri: string; preferredModelDisplayMode: McpAppDisplayMode };
export type McpToolCallAppContext = {
  connectorId: string;
  linkId: string | null;
  resourceUri: string | null;
  appName: string | null;
  actionName: string | null;
};
export type McpToolCallError = { message: string };
export type McpToolCallResult = {
  content: Array<JsonValue>;
  structuredContent: JsonValue | null;
  _meta: JsonValue | null;
};
export type McpToolCallStatus = 'inProgress' | 'completed' | 'failed';
export type MemoryCitationEntry = {
  path: string;
  lineStart: number;
  lineEnd: number;
  note: string;
};
export type MemoryCitation = { entries: Array<MemoryCitationEntry>; threadIds: Array<string> };
export type PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
export type SubAgentActivityKind = 'started' | 'interacted' | 'interrupted' | 'completed';
export type ByteRange = { start: number; end: number };
export type TextElement = {
  byteRange: ByteRange;

  placeholder: string | null;
};
export type UserInput =
  | {
      type: 'text';
      text: string;

      text_elements: Array<TextElement>;
    }
  | ({ type: 'image'; detail?: ImageDetail } & ({ url: string } | { fileId: string }))
  | { type: 'localImage'; detail?: ImageDetail; path: string }
  | { type: 'audio'; url: string }
  | { type: 'localAudio'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };
export type ThreadItem =
  | { type: 'userMessage'; id: string; clientId: string | null; content: Array<UserInput> }
  | { type: 'hookPrompt'; id: string; fragments: Array<HookPromptFragment> }
  | {
      type: 'agentMessage';
      id: string;
      text: string;
      phase: MessagePhase | null;
      memoryCitation: MemoryCitation | null;
      delivery: AgentMessageDelivery | null;
      questions: Array<AsyncUserInputQuestion> | null;
    }
  | {
      type: 'functionCallOutput';
      id: string;
      name: string;
      namespace: string | null;
      output: FunctionCallOutputBody;
    }
  | { type: 'plan'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: Array<string>; content: Array<string> }
  | {
      type: 'commandExecution';
      id: string;

      pluginId: string | null;

      scriptPath: string | null;

      command: string;

      cwd: LegacyAppPathString;

      processId: string | null;
      source: CommandExecutionSource;
      status: CommandExecutionStatus;

      commandActions: Array<CommandAction>;

      aggregatedOutput: string | null;

      exitCode: number | null;

      durationMs: number | null;
    }
  | { type: 'fileChange'; id: string; changes: Array<FileUpdateChange>; status: PatchApplyStatus }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: McpToolCallStatus;
      arguments: JsonValue;
      appContext: McpToolCallAppContext | null;

      mcpAppResourceUri?: string;

      mcpAppUi: McpAppUi | null;
      pluginId: string | null;
      readOnlyHint: boolean | null;
      result: McpToolCallResult | null;
      error: McpToolCallError | null;

      durationMs: number | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      namespace: string | null;
      tool: string;
      arguments: JsonValue;
      status: DynamicToolCallStatus;
      contentItems: Array<DynamicToolCallOutputContentItem> | null;
      success: boolean | null;

      durationMs: number | null;
    }
  | {
      type: 'collabAgentToolCall';

      id: string;

      tool: CollabAgentTool;

      status: CollabAgentToolCallStatus;

      senderThreadId: string;

      receiverThreadIds: Array<string>;

      prompt: string | null;

      model: string | null;

      reasoningEffort: ReasoningEffort | null;

      agentsStates: { [key in string]?: CollabAgentState };
    }
  | {
      type: 'subAgentActivity';
      id: string;
      kind: SubAgentActivityKind;
      agentThreadId: string;
      agentPath: string;
    }
  | ({ type: 'webSearch' } & WebSearchItem)
  | { type: 'imageView'; id: string; path: LegacyAppPathString }
  | ({ type: 'sleep' } & SleepItem)
  | ({ type: 'imageGeneration' } & ImageGenerationItem)
  | { type: 'enteredReviewMode'; id: string; review: string }
  | { type: 'exitedReviewMode'; id: string; review: string }
  | { type: 'contextCompaction'; id: string };
