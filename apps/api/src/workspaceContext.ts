import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkspaceActor } from '@repellet/shared';
export const workspaceContext = new AsyncLocalStorage<{
  requestId: string;
  projectId?: string;
  actor?: WorkspaceActor;
}>();
