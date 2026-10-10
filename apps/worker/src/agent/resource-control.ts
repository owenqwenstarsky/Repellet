import { parseResourceControlRequest, resourceWriteOperations } from '@repellet/shared';
import type { ResourceControlResult } from '@repellet/agent-protocol';
import { config } from '../config.js';

type Context = {
  projectId: string;
  userId: string;
  active: () => { threadId: string; turnId: string } | null;
  planMode: (threadId: string) => boolean;
};
export async function forwardResourceControl(
  context: Context,
  input: unknown,
  signal: AbortSignal,
): Promise<ResourceControlResult> {
  const fail = (code: string, message: string, uncertain = false): ResourceControlResult => ({
    error: { code, message, ...(uncertain ? { uncertain: true } : {}) },
  });
  let parsed;
  try {
    parsed = parseResourceControlRequest(input);
  } catch {
    return fail('invalid_request', 'Invalid resource tool arguments.');
  }
  const { threadId, turnId, ...control } = parsed;
  const active = context.active();
  if (!active || active.threadId !== threadId || active.turnId !== turnId)
    return fail('inactive_turn', 'Resource tools require the current active agent turn.');
  const write = (resourceWriteOperations as readonly string[]).includes(control.operation);
  if (write && context.planMode(threadId))
    return fail(
      'plan_mode',
      'Plan mode is read-only. Leave plan mode before changing databases or variables.',
    );
  if (signal.aborted) return fail('cancelled', 'Resource request cancelled.');
  try {
    const response = await fetch(`${config.appUrl}/internal/agent/resource-control`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: context.projectId, userId: context.userId, control }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(
        'resource_unavailable',
        'Resource request failed. Inspect current state before retrying.',
        write,
      );
    }
    const result = (await response.json()) as ResourceControlResult;
    if (!result || typeof result !== 'object' || (!Object.hasOwn(result, 'data') && !result.error))
      throw new Error('Invalid resource response');
    return result;
  } catch {
    return fail(
      signal.aborted ? 'cancelled' : 'resource_unavailable',
      'Resource request did not complete. Inspect current state before retrying; do not replay writes automatically.',
      write,
    );
  }
}
