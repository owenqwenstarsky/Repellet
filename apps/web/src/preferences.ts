import type { WorkspacePreferences } from '@repellet/shared';
export const preferenceKey = (user: string, project: string) =>
  `repellet:workspace:1:${location.origin}:${user}:${project}`;
const clamp = (v: unknown, fallback: number, min: number, max: number) =>
  Math.max(min, Math.min(max, typeof v === 'number' && Number.isFinite(v) ? v : fallback));
export function readPreferences(key: string): WorkspacePreferences {
  let value: Partial<WorkspacePreferences> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '{}');
    if (parsed?.version === 1) value = parsed;
  } catch {}
  const tabs = Array.isArray(value.tabs)
    ? value.tabs
        .filter(
          (p): p is string =>
            typeof p === 'string' && !p.startsWith('/') && !p.split('/').includes('..'),
        )
        .slice(0, 100)
    : [];
  const positions: WorkspacePreferences['positions'] = {};
  for (const path of tabs) {
    const pos = value.positions?.[path];
    if (pos)
      positions[path] = {
        line: clamp(pos.line, 1, 1, 10000000),
        column: clamp(pos.column, 1, 1, 10000000),
        scrollTop: clamp(pos.scrollTop, 0, 0, 100000000),
        scrollLeft: clamp(pos.scrollLeft, 0, 0, 100000000),
      };
  }
  return {
    version: 1,
    tabs,
    active: tabs.includes(value.active || '') ? value.active! : tabs[0] || '',
    positions,
    pane: ['files', 'search', 'git', 'problems'].includes(value.pane || '') ? value.pane! : 'files',
    showSidebar: value.showSidebar !== false,
    showPreview: value.showPreview !== false,
    rightPanel:
      value.rightPanel === 'database' && value.databaseOpen === true
        ? 'database'
        : value.rightPanel === 'agent'
          ? 'agent'
          : 'preview',
    databaseOpen: value.databaseOpen === true,
    lastFixedRightPanel: value.lastFixedRightPanel === 'agent' ? 'agent' : 'preview',
    agentThread:
      typeof value.agentThread === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value.agentThread)
        ? value.agentThread
        : '',
    bottomPanelTab: value.bottomPanelTab === 'preparation' ? 'preparation' : 'terminal',
    showTerminal: value.showTerminal === true,
    leftWidth: clamp(value.leftWidth, 232, 150, Math.max(150, innerWidth * 0.35)),
    previewWidth: clamp(value.previewWidth, 420, 200, Math.max(200, innerWidth * 0.45)),
    terminalHeight: clamp(value.terminalHeight, 230, 100, Math.max(100, innerHeight * 0.6)),
    terminal: typeof value.terminal === 'string' ? value.terminal : '',
  };
}
export function savePreferences(key: string, value: WorkspacePreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
