export type ProjectControlInput =
  | { operation: 'status' | 'start' | 'stop'; arguments: Record<string, never> }
  | { operation: 'logs'; arguments: { tailLines?: number } };

export type ProjectControlRequest = ProjectControlInput & { threadId: string; turnId: string };

export type ProjectControlStatus = {
  workspaceState: string;
  runState: 'running' | 'not_running' | 'starting' | 'unknown';
  command: string | null;
  cwd: string | null;
  preparation: { status: string; error: string | null };
  blockers: string[];
  preview: { status: string; httpStatus?: number; error?: string };
  processes: Array<{ id: string; name: string; status: string }>;
};

export type ProjectControlResult = {
  outcome:
    | 'status'
    | 'logs'
    | 'started'
    | 'already_running'
    | 'stopped'
    | 'not_running'
    | 'starting'
    | 'error';
  status?: ProjectControlStatus;
  logs?: Array<{ processId: string; name: string; text: string; truncated: boolean }>;
  truncated?: boolean;
  error?: { code: string; message: string; uncertain?: boolean };
};
