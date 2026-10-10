import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TerminalInfo } from '@repellet/shared';
import { api, post, errorMessage } from '../api';
// Terminal list for a running workspace. Creates a first terminal for editors when none exist.
export function useTerminals(
  base: string,
  initial: string,
  editable: boolean,
  mounted: RefObject<boolean>,
) {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [terminal, setTerminal] = useState(initial);
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const [initialReady, setInitialReady] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const creating = useRef(false);
  const loading = useRef(false);
  const closed = useRef(new Set<string>());
  const reloadPending = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
      loading.current = false;
      reloadPending.current = false;
    },
    [base],
  );
  async function reload(force = false) {
    if (force === true) {
      controller.current?.abort();
      loading.current = false;
    }
    if (loading.current) {
      reloadPending.current = true;
      return;
    }
    loading.current = true;
    const request = ++generation.current;
    const current = () => mounted.current && request === generation.current;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const list = (
        await api<TerminalInfo[]>(base + '/terminals', { signal: abort.signal })
      ).filter((t) => !closed.current.has(t.id));
      if (!current()) return;
      setTerminals(list);
      setError('');
      setTerminal((previous) =>
        list.some((t) => t.id === previous)
          ? previous
          : list.find((t) => t.isMainRun && t.alive)?.id ||
            list.find((t) => t.isRun && t.alive)?.id ||
            list[0]?.id ||
            '',
      );
      const firstLoad = !initialized.current;
      if (list.length || !editable) initialized.current = true;
      if (!list.length && editable && firstLoad) {
        // A retry can inspect the list while creation is pending, but must not create twice.
        if (creating.current) return;
        creating.current = true;
        let created: TerminalInfo;
        try {
          created = await post<TerminalInfo>(base + '/terminals', { name: 'Terminal 1' });
        } finally {
          creating.current = false;
        }
        if (!current()) return;
        initialized.current = true;
        setTerminals([created]);
        setTerminal(created.id);
      }
      setInitialReady(true);
    } catch (e) {
      if (current()) setError(errorMessage(e));
    } finally {
      if (current()) {
        loading.current = false;
        if (reloadPending.current) {
          reloadPending.current = false;
          void reload();
        }
      }
    }
  }
  function didClose(id: string) {
    closed.current.add(id);
    setTerminals((list) => list.filter((t) => t.id !== id));
    setTerminal((selected) => (selected === id ? '' : selected));
  }
  return { terminals, terminal, setTerminal, error, initialReady, reload, didClose };
}
