import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import { X, AlertCircle, Check, Loader2, ChevronDown } from 'lucide-react';
type DialogRequest = {
  title: string;
  description?: string;
  label?: string;
  value?: string;
  confirm?: boolean;
  danger?: boolean;
  password?: boolean;
};
type Ui = {
  notify: (message: string, kind?: 'error' | 'success') => void;
  ask: (request: DialogRequest) => Promise<string | null>;
};
const Context = createContext<Ui>(null!);
export const useUi = () => useContext(Context);
export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([]);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState('');
  const resolve = useRef<((value: string | null) => void) | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      resolve.current?.(null);
      resolve.current = null;
      for (const timer of timers.current) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );
  const notify = (text: string, kind = 'error') => {
    const id = Date.now() + Math.random();
    setToasts((v) => [...v.slice(-3), { id, text, kind }]);
    const timer = setTimeout(
      () => {
        timers.current.delete(timer);
        setToasts((v) => v.filter((t) => t.id !== id));
      },
      kind === 'error' ? 10000 : 4000,
    );
    timers.current.add(timer);
  };
  const finish = (result: string | null) => {
    resolve.current?.(result);
    resolve.current = null;
    setDialog(null);
  };
  const ask = (request: DialogRequest) =>
    new Promise<string | null>((done) => {
      resolve.current?.(null);
      resolve.current = done;
      setValue(request.value || '');
      setDialog(request);
    });
  return (
    <Context.Provider value={{ notify, ask }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.kind}`} key={t.id}>
            {t.kind === 'error' ? <AlertCircle size={18} /> : <Check size={18} />}
            <span>{t.text}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => setToasts((v) => v.filter((x) => x.id !== t.id))}
            >
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
      {dialog && (
        <Modal title={dialog.title} onClose={() => finish(null)} small>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              finish(dialog.confirm ? 'yes' : value);
            }}
          >
            {dialog.description && <p className="muted dialog-description">{dialog.description}</p>}
            {!dialog.confirm && (
              <label>
                {dialog.label || 'Name'}
                <input
                  autoFocus
                  type={dialog.password ? 'password' : 'text'}
                  value={value}
                  required
                  onChange={(e) => setValue(e.target.value)}
                />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="button secondary" onClick={() => finish(null)}>
                Cancel
              </button>
              <button
                className={`button ${dialog.danger ? 'danger' : 'primary'}`}
                autoFocus={dialog.confirm}
              >
                {dialog.confirm ? 'Confirm' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Context.Provider>
  );
}
export function Modal({
  title,
  children,
  onClose,
  small = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  small?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  const initialFocus = useRef<HTMLElement | null>(null);
  const topmost = () => isTopDialog(ref.current);
  useLayoutEffect(() => {
    if (ref.current?.contains(document.activeElement))
      initialFocus.current = document.activeElement as HTMLElement;
    if (topmost() && !ref.current?.contains(document.activeElement))
      (initialFocus.current || focusable(ref.current!)[0] || ref.current)?.focus();
    const handler = (e: KeyboardEvent) => {
      if (!topmost() || e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
      if (e.key === 'Tab' && ref.current) {
        const elements = focusable(ref.current);
        const first = elements[0],
          last = elements.at(-1);
        if (!first) {
          e.preventDefault();
          ref.current.focus();
        } else if (
          !ref.current.contains(document.activeElement) ||
          (e.shiftKey && document.activeElement === first)
        ) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      const remaining = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
        .filter((el) => el !== ref.current && !ref.current?.contains(el))
        .at(-1);
      if (opener?.isConnected && (!remaining || remaining.contains(opener))) opener.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && topmost()) close.current();
      }}
    >
      <div
        ref={ref}
        className={`modal ${small ? 'small' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={() => {
              if (topmost()) close.current();
            }}
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
function isTopDialog(element: HTMLElement | null) {
  return [...document.querySelectorAll('[role="dialog"]')].at(-1) === element;
}
function focusable(root: HTMLElement) {
  return [
    ...root.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]'),
  ].filter((el) => {
    if (
      el.tabIndex < 0 ||
      el.matches(':disabled') ||
      el.closest('[hidden],[inert],[aria-hidden="true"]')
    )
      return false;
    for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  });
}
export function Dropdown({
  children,
  onClose,
  className = '',
  style,
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  close.current = onClose;
  const restore = () => {
    if (opener?.isConnected) opener.focus();
  };
  useLayoutEffect(() => {
    focusable(ref.current!)[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (!document.querySelector('[role="dialog"]')) restore();
    };
  }, []);
  return (
    <div ref={ref} className={`dropdown ${className}`} style={style} onClickCapture={restore}>
      {children}
    </div>
  );
}
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <Loader2 size={20} className="spin" />
      <span>{label}</span>
    </div>
  );
}
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <svg
        width={compact ? 27 : 32}
        height={compact ? 27 : 32}
        viewBox="0 0 40 40"
        aria-hidden="true"
      >
        <rect width="40" height="40" rx="10" fill="currentColor" />
        <path
          d="M12 11h9a7 7 0 0 1 0 14h-3l9 7M12 11v21m0-14h9"
          fill="none"
          stroke="#10181a"
          strokeWidth="4"
          strokeLinejoin="round"
        />
      </svg>
      <span>Repellet</span>
    </div>
  );
}
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.37) }}
      title={name}
    >
      {name
        .split(/\s/)
        .map((v) => v[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()}
    </span>
  );
}
export function Status({ state }: { state: string }) {
  return (
    <span className={`status ${state}`}>
      <i />
      {state.charAt(0).toUpperCase() + state.slice(1)}
    </span>
  );
}
