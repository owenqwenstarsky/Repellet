import { parseProjectControlRequest } from '@repellet/shared';
import type { ProjectControlResult } from '@repellet/agent-protocol';
import { config } from '../config.js';

type Context = {
  projectId: string;
  userId: string;
  active: () => { threadId: string; turnId: string } | null;
  planMode: (threadId: string) => boolean;
};

/** Identity comes only from the worker-owned session, never tool arguments. No retries. */
export async function forwardProjectControl(
  context: Context,
  input: unknown,
  signal: AbortSignal,
): Promise<ProjectControlResult> {
  const fail = (code: string, message: string, uncertain = false): ProjectControlResult => ({
    outcome: 'error',
    error: { code, message, ...(uncertain ? { uncertain: true } : {}) },
  });
  const parsed = (() => {
    try {
      return parseProjectControlRequest(input);
    } catch {
      return null;
    }
  })();
  if (!parsed) return fail('invalid_request', 'Invalid project tool arguments.');
  const { threadId, turnId, ...control } = parsed;
  const active = context.active();
  if (!active || active.threadId !== threadId || active.turnId !== turnId)
    return fail('inactive_turn', 'Project tools require the current active agent turn.');
  if (['start', 'stop'].includes(control.operation) && context.planMode(threadId))
    return fail(
      'plan_mode',
      'Plan mode is read-only. Leave plan mode before starting or stopping the app.',
    );
  if (signal.aborted) return fail('cancelled', 'Project request cancelled.');
  try {
    const response = await fetch(`${config.appUrl}/internal/agent/project-control`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: context.projectId, userId: context.userId, control }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(
        response.status === 401 || response.status === 403
          ? 'access_denied'
          : 'control_unavailable',
        'Project control is unavailable. Call project_status before retrying.',
        ['start', 'stop'].includes(control.operation),
      );
    }
    const result = (await response.json()) as ProjectControlResult;
    if (
      !result ||
      ![
        'status',
        'logs',
        'started',
        'already_running',
        'stopped',
        'not_running',
        'starting',
        'error',
      ].includes(result.outcome)
    )
      throw new Error('Invalid project response');
    return result;
  } catch {
    return fail(
      signal.aborted ? 'cancelled' : 'control_unavailable',
      'Project request did not complete. Call project_status before retrying; never automatically replay start or stop.',
      ['start', 'stop'].includes(control.operation),
    );
  }
}
