import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
export function PageHeader({
  eyebrow,
  title,
  count,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  count?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>
          {title}
          {count !== undefined && <span className="count">{count}</span>}
        </h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
export function Section({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section ${className}`}>
      <div className="section-header">
        <div>
          <h3>{title}</h3>
          {description && <p className="section-description">{description}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}
// Compact header for workspace panes. Source text is title case; CSS uppercases it.
export function PaneHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="pane-header">
      <h2 className="pane-title">{title}</h2>
      {actions && <div className="pane-actions">{actions}</div>}
    </div>
  );
}
const icons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
};
export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  role,
  compact = false,
  className = '',
}: {
  tone?: keyof typeof icons;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  role?: 'alert' | 'status';
  compact?: boolean;
  className?: string;
}) {
  const Icon = icons[tone];
  return (
    <div
      className={`banner ${tone} ${compact ? 'compact' : ''} ${className}`}
      role={role ?? (tone === 'danger' ? 'alert' : undefined)}
    >
      <Icon size={compact ? 14 : 16} className="banner-icon" aria-hidden="true" />
      <div className="banner-body">
        {title && <strong>{title}</strong>}
        {children}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`empty-state ${className}`}>
      {icon && <div className="empty-icon">{icon}</div>}
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {action}
    </div>
  );
}
const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform);
const symbols: Record<string, string> = mac
  ? { mod: '⌘', shift: '⇧', enter: '↵' }
  : { mod: 'Ctrl', shift: 'Shift', enter: 'Enter' };
export const shortcutText = (keys: string[]) =>
  keys.map((k) => symbols[k.toLowerCase()] || k).join(mac ? '' : '+');
export function Shortcut({ keys }: { keys: string[] }) {
  return <kbd>{shortcutText(keys)}</kbd>;
}
