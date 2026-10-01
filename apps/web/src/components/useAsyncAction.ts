import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';
import { useUi } from '../ui';
// One in-flight guard per component: ignores re-entry, skips state updates after unmount,
// and reports failures as a toast unless the caller handles them.
export function useAsyncAction(onError?: (error: unknown) => void) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);
  const handler = useRef(onError);
  handler.current = onError;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      if (pending.current) return undefined;
      pending.current = true;
      setBusy(true);
      try {
        return await fn();
      } catch (e) {
        if (handler.current) handler.current(e);
        else ui.notify(errorMessage(e));
        return undefined;
      } finally {
        pending.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [ui],
  );
  // Marks the owner as gone before React unmounts it, e.g. when a dialog is dismissed mid-request.
  const dispose = useCallback(() => {
    alive.current = false;
  }, []);
  return { busy, run, alive, dispose, pending };
}
