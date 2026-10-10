import type { ProjectState, TerminalInfo } from '@repellet/shared';
import { mainRunProcessIds } from './preparation.js';
import { bridge } from './worker.js';

/** Read process activity without starting the workspace or changing idle activity. */
export async function mainAppRunning(project: { id: string; state: ProjectState | string }) {
  if (project.state !== 'running') return false;
  try {
    const mainIds = await mainRunProcessIds(project.id);
    const terminals = await bridge<TerminalInfo[]>(project.id, '/terminals');
    return terminals.some(
      (terminal) => mainIds.has(terminal.id) && terminal.isRun === true && terminal.alive === true,
    );
  } catch {
    return false;
  }
}
