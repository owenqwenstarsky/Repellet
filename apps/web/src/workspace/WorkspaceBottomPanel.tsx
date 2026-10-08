import { useId, useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../ui';

export type BottomPanelTab = {
  id: string;
  label: string;
  content: ReactNode;
  actions?: ReactNode;
};

export function WorkspaceBottomPanel({
  tabs,
  active,
  visible,
  height,
  onSelect,
  onHide,
}: {
  tabs: BottomPanelTab[];
  active: string;
  visible: boolean;
  height: number;
  onSelect: (id: string) => void;
  onHide: () => void;
}) {
  const id = useId();
  const [visited, setVisited] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (visible) setVisited((old) => (old.has(active) ? old : new Set([...old, active])));
  }, [active, visible]);
  return (
    <section
      className="workspace-bottom-panel"
      aria-label="Bottom panel"
      hidden={!visible}
      style={{ height }}
    >
      <div className="bottom-panel-toolbar">
        <div
          role="tablist"
          aria-label="Bottom panel tabs"
          className="bottom-panel-tabs"
          onKeyDown={(event) => {
            const index = tabs.findIndex((tab) => tab.id === active);
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index - 1 + tabs.length) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            onSelect(tabs[next]!.id);
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${id}-tab-${tab.id}`}
              aria-controls={`${id}-panel-${tab.id}`}
              aria-selected={active === tab.id}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {tabs.find((tab) => tab.id === active)?.actions}
        <IconButton size="sm" label="Hide bottom panel" icon={<X size={14} />} onClick={onHide} />
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${id}-panel-${tab.id}`}
          aria-labelledby={`${id}-tab-${tab.id}`}
          className="bottom-panel-content"
          hidden={active !== tab.id}
        >
          {(visited.has(tab.id) || (visible && active === tab.id)) && tab.content}
        </div>
      ))}
    </section>
  );
}
