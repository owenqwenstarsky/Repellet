import { useEffect, useRef, useState } from 'react';
import type { Project, PreparationJob } from '@repellet/shared';
import { api, post, errorMessage } from '../api';
import { useUi } from '../ui';
// Polls the project, its preparation log and (while building) its build log.
export function useProjectPolling(id: string) {
  const ui = useUi();
  const base = `/projects/${id}`;
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState('');
  const [buildLog, setBuildLog] = useState('');
  const [logError, setLogError] = useState('');
  const [preparationLog, setPreparationLog] = useState('');
  const loadVersion = useRef(0);
  const pollPending = useRef(false);
  const mounted = useRef(true);
  async function load() {
    if (pollPending.current) return;
    pollPending.current = true;
    const request = ++loadVersion.current;
    try {
      const p = await api<Project>(base);
      if (!mounted.current || request !== loadVersion.current) return;
      setProject(p);
      setLoadError('');
      if (p.preparation.status !== 'none') {
        const progress = await api<{ jobs: PreparationJob[] }>(base + '/preparation');
        if (mounted.current && request === loadVersion.current)
          setPreparationLog(progress.jobs.find((j) => j.step)?.log || '');
      }
      if (p.state === 'building' || p.state === 'starting') {
        try {
          const log = await api<{ log: string }>(base + '/build-log');
          if (mounted.current) {
            setBuildLog(log.log);
            setLogError('');
          }
        } catch (e) {
          if (mounted.current) setLogError(errorMessage(e));
        }
      }
    } catch (e) {
      if (mounted.current && request === loadVersion.current) setLoadError(errorMessage(e));
    } finally {
      pollPending.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    void post(base + '/open').catch((e) => ui.notify(errorMessage(e)));
    const timer = setInterval(load, 2000);
    return () => {
      mounted.current = false;
      loadVersion.current++;
      clearInterval(timer);
    };
  }, [id]);
  return { project, setProject, load, loadError, buildLog, logError, preparationLog, mounted };
}
