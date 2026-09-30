import {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  type ReactNode,
  type CSSProperties,
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
  minLength?: number;
  maxLength?: number;
  pattern?: string;
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
                  data-autofocus
                  type={dialog.password ? 'password' : 'text'}
                  value={value}
                  required
                  minLength={dialog.minLength ?? (dialog.password ? 12 : 1)}
                  maxLength={dialog.maxLength ?? (dialog.password ? 128 : undefined)}
                  pattern={dialog.pattern}
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
                data-autofocus={dialog.confirm || undefined}
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
const modalStack: HTMLElement[] = [];
const menuTriggers = new WeakMap<HTMLElement, HTMLElement | null>();
function focusTrigger(active: HTMLElement | null): HTMLElement | null {
  const menu = active?.closest<HTMLElement>('[role="menu"]');
  return menu && menuTriggers.has(menu) ? focusTrigger(menuTriggers.get(menu) || null) : active;
}
export const hasOpenDialog = () => modalStack.length > 0;

export function Menu({
  children,
  onClose,
  className = '',
  style,
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const trigger = useRef(focusTrigger(document.activeElement as HTMLElement | null));
  useLayoutEffect(() => {
    const menu = ref.current!;
    menuTriggers.set(menu, trigger.current);
    const items = () => [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    items().forEach((item) => {
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
    });
    items()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (hasOpenDialog()) return;
      const buttons = items(),
        index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (['Escape', 'Tab'].includes(e.key)) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        close.current();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        buttons[
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        ]?.focus();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      if (
        trigger.current?.isConnected &&
        (menu.contains(document.activeElement) || document.activeElement === document.body)
      )
        trigger.current.focus();
    };
  }, []);
  return (
    <div ref={ref} role="menu" className={`dropdown ${className}`} style={style}>
      {children}
    </div>
  );
}

export function LoadError({
  message,
  onRetry,
  retryLabel = 'Retry',
}: {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="load-error" role="alert">
      <p>{message}</p>
      <button className="button secondary small" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
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
  const close = useRef(onClose);
  close.current = onClose;
  const trigger = useRef(focusTrigger(document.activeElement as HTMLElement | null));
  const layer = useRef(100 + modalStack.length);
  const initialFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current!;
    modalStack.push(element);
    const controls = () => focusable(element);
    if (element.contains(document.activeElement))
      initialFocus.current = document.activeElement as HTMLElement;
    if (!element.contains(document.activeElement))
      (
        initialFocus.current ||
        element.querySelector<HTMLElement>('[data-autofocus]') ||
        controls()[0] ||
        element
      ).focus();
    const handler = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== element) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      }
      if (e.key === 'Tab') {
        const elements = controls();
        const first = elements[0],
          last = elements.at(-1);
        if (!elements.length) {
          e.preventDefault();
          element.focus();
        } else if (
          !element.contains(document.activeElement) ||
          (e.shiftKey && document.activeElement === first) ||
          (!e.shiftKey && document.activeElement === last)
        ) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
    };
    const keepFocus = (e: FocusEvent) => {
      if (modalStack.at(-1) === element && !element.contains(e.target as Node))
        (controls()[0] || element).focus();
    };
    document.addEventListener('keydown', handler, true);
    document.addEventListener('focusin', keepFocus);
    return () => {
      modalStack.splice(modalStack.indexOf(element), 1);
      document.removeEventListener('keydown', handler, true);
      document.removeEventListener('focusin', keepFocus);
      const old = trigger.current;
      const restore = () => {
        if (
          old?.isConnected &&
          !old.matches(':disabled') &&
          (!modalStack.length || modalStack.at(-1)!.contains(old))
        )
          old.focus();
        else modalStack.at(-1)?.focus();
      };
      restore();
      // A pending action can re-enable its trigger in a later React commit.
      if (old?.matches(':disabled')) {
        const fallback = document.activeElement;
        const observer = new MutationObserver(() => {
          if (!old.matches(':disabled')) {
            observer.disconnect();
            if (document.activeElement === fallback || document.activeElement === document.body)
              restore();
          }
        });
        observer.observe(old, { attributes: true, attributeFilter: ['disabled'] });
        setTimeout(() => observer.disconnect(), 1000);
      }
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: layer.current }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && modalStack.at(-1) === ref.current) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal ${small ? 'small' : ''}`}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <h2 title={title}>{title}</h2>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
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
export const Dropdown = Menu;
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
