import { useEffect, useRef, useState } from 'react';
import type { Project, PreparationJob } from '@repellet/shared';
import { api, post, errorMessage } from '../api';
// Polls the project, its preparation log and (while building) its build log.
export function useProjectPolling(id: string) {
  const base = `/projects/${id}`;
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState('');
  const [buildLog, setBuildLog] = useState('');
  const [logError, setLogError] = useState('');
  const [preparationLog, setPreparationLog] = useState('');
  const [openPending, setOpenPending] = useState(true);
  const [openError, setOpenError] = useState('');
  const openVersion = useRef(0);
  const opening = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const logController = useRef<AbortController | null>(null);
  const logVersion = useRef(0);
  const logsPending = useRef(false);
  const loadVersion = useRef(0);
  const pollPending = useRef(false);
  const mounted = useRef(true);
  async function loadLogs(p: Project) {
    if (logsPending.current) return;
    logsPending.current = true;
    const request = ++logVersion.current;
    const current = () => mounted.current && request === logVersion.current;
    const abort = new AbortController();
    logController.current = abort;
    const requests: Promise<unknown>[] = [];
    if (p.preparation.status !== 'none')
      requests.push(
        api<{ jobs: PreparationJob[] }>(base + '/preparation', { signal: abort.signal })
          .then((progress) => {
            if (current()) setPreparationLog(progress.jobs.find((j) => j.step)?.log || '');
          })
          .catch((e) => {
            if (current()) setLogError(errorMessage(e));
          }),
      );
    if (['building', 'starting', 'failed'].includes(p.state))
      requests.push(
        api<{ log: string }>(base + '/build-log', { signal: abort.signal })
          .then((log) => {
            if (current()) {
              setBuildLog(log.log);
              setLogError('');
            }
          })
          .catch((e) => {
            if (current()) setLogError(errorMessage(e));
          }),
      );
    await Promise.allSettled(requests);
    if (current()) logsPending.current = false;
  }
  async function load(force = false) {
    if (force) {
      controller.current?.abort();
      logController.current?.abort();
      logVersion.current++;
      logsPending.current = false;
      pollPending.current = false;
    }
    if (pollPending.current) return;
    pollPending.current = true;
    const request = ++loadVersion.current;
    const current = () => mounted.current && request === loadVersion.current;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const p = await api<Project>(base, { signal: abort.signal });
      if (!current()) return;
      setProject(p);
      setLoadError('');
      // Logs are ancillary: a slow log request must not stop lifecycle polling.
      void loadLogs(p);
    } catch (e) {
      if (current()) setLoadError(errorMessage(e));
    } finally {
      if (current()) pollPending.current = false;
    }
  }
  async function open(force = false) {
    if (opening.current && !force) return;
    opening.current = true;
    const request = ++openVersion.current;
    setOpenPending(true);
    setOpenError('');
    try {
      await post(base + '/open');
    } catch (e) {
      if (mounted.current && request === openVersion.current) setOpenError(errorMessage(e));
    } finally {
      if (mounted.current && request === openVersion.current) {
        opening.current = false;
        setOpenPending(false);
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    void open();
    const timer = setInterval(load, 2000);
    return () => {
      mounted.current = false;
      loadVersion.current++;
      openVersion.current++;
      opening.current = false;
      pollPending.current = false;
      controller.current?.abort();
      logController.current?.abort();
      logVersion.current++;
      logsPending.current = false;
      clearInterval(timer);
    };
  }, [id]);
  return {
    project,
    setProject,
    load,
    loadError,
    buildLog,
    logError,
    preparationLog,
    mounted,
    open,
    openPending,
    openError,
  };
}
