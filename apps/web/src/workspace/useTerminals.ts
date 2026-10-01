import { useRef, useState, type RefObject } from 'react';
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
  const loading = useRef(false);
  async function reload() {
    if (loading.current) return;
    loading.current = true;
    try {
      const list = await api<TerminalInfo[]>(base + '/terminals');
      if (!mounted.current) return;
      setTerminals(list);
      setError('');
      setTerminal((previous) =>
        list.some((t) => t.id === previous)
          ? previous
          : list.find((t) => t.isRun && t.alive)?.id || list[0]?.id || '',
      );
      if (!list.length && editable && !initialized.current) {
        const created = await post<TerminalInfo>(base + '/terminals', { name: 'Terminal 1' });
        initialized.current = true;
        if (mounted.current) {
          setTerminals([created]);
          setTerminal(created.id);
        }
      }
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
    } finally {
      loading.current = false;
    }
  }
  return { terminals, terminal, setTerminal, error, reload };
}
