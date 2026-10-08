import {
  Files,
  Search,
  GitBranch,
  CircleAlert,
  PanelRight,
  TerminalSquare,
  Bot,
} from 'lucide-react';
const tools = [
  ['files', 'Files', Files],
  ['search', 'Search', Search],
  ['git', 'Source control', GitBranch],
  ['problems', 'Problems', CircleAlert],
] as const;
export function ActivityBar({
  pane,
  showSidebar,
  showTerminal,
  showPreview,
  onPane,
  onToggleTerminal,
  onTogglePreview,
  agentOwner = false,
  agentActive = false,
  onAgent,
}: {
  agentOwner?: boolean;
  agentActive?: boolean;
  onAgent?: () => void;
  pane: string;
  showSidebar: boolean;
  showTerminal: boolean;
  showPreview: boolean;
  onPane: (name: string) => void;
  onToggleTerminal: () => void;
  onTogglePreview: () => void;
}) {
  return (
    <nav className="activity-bar" aria-label="Workspace tools">
      {tools.map(([name, label, Icon]) => {
        const active = pane === name && showSidebar;
        return (
          <button
            key={name}
            className={active ? 'active' : ''}
            aria-pressed={active}
            aria-label={label}
            title={active ? `${label} (click to hide sidebar)` : label}
            onClick={() => onPane(name)}
          >
            <Icon size={19} />
          </button>
        );
      })}
      {agentOwner && (
        <button
          aria-label="Agent"
          title="Agent"
          aria-pressed={agentActive}
          className={agentActive ? 'active' : ''}
          onClick={onAgent}
        >
          <Bot size={19} />
        </button>
      )}
      <div className="activity-spacer" />
      <button
        aria-pressed={showTerminal}
        aria-label="Toggle bottom panel"
        title="Toggle bottom panel"
        className={showTerminal ? 'active-subtle' : ''}
        onClick={onToggleTerminal}
      >
        <TerminalSquare size={19} />
      </button>
      <button
        aria-pressed={showPreview}
        aria-label="Toggle preview"
        title="Toggle preview"
        className={showPreview ? 'active-subtle' : ''}
        onClick={onTogglePreview}
      >
        <PanelRight size={19} />
      </button>
    </nav>
  );
}
