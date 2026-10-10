import { useEffect, useRef, useState, type RefObject } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type {
  FileContent,
  Project,
  WorkspacePreferences,
  DocumentIdentity,
} from '@repellet/shared';
import { starterCatalog } from '@repellet/shared';
import { api, errorMessage } from '../api';
import { useUi } from '../ui';
import { flushOpenDocuments } from '../documentSaves';
import { remapPath, type StructureChange } from '../workspaceState';
import { WorkspaceSession, type WorkspaceSnapshot } from './session';
// Open editor tabs, the active file and per-file view state, including restore after reload.
export function useEditorTabs(
  id: string,
  saved: WorkspacePreferences,
  project: Project | null,
  mounted: RefObject<boolean>,
  attempt = 0,
) {
  const ui = useUi();
  const base = `/projects/${id}`;
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [selection, setSelection] = useState<{ line: number; column: number }>();
  const [structure, setStructure] = useState<StructureChange[]>([]);
  const restored = useRef(false);
  const [selectionReady, setSelectionReady] = useState(false);
  const [restoreComplete, setRestoreComplete] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [backgroundAttempt, setBackgroundAttempt] = useState(0);
  const selectionResolved = useRef(false);
  const excludedRestores = useRef(new Set<string>());
  const positions = useRef(saved.positions);
  const viewStates = useRef(new Map<string, MonacoEditor.ICodeEditorViewState>());
  const fileIntent = useRef(0);
  const tabsRef = useRef(tabs);
  const registry = useRef(new WorkspaceSession(id));
  tabsRef.current = tabs;
  function commit(next: string[]) {
    tabsRef.current = next;
    setTabs(next);
  }
  useEffect(() => {
    if (project?.state !== 'running' || restored.current) return;
    let disposed = false;
    const controller = new AbortController();
    const version = fileIntent.current;
    let selected = selectionResolved.current;
    const current = () =>
      !disposed && !restored.current && (selected || version === fileIntent.current);
    setRestoreError('');
    void (async () => {
      const initialFile = starterCatalog.find((s) => s.id === project.starterId)?.initialFile;
      const candidates = saved.tabs.length ? saved.tabs : initialFile ? [initialFile] : [];
      const ordered = candidates.includes(saved.active)
        ? [saved.active, ...candidates.filter((path) => path !== saved.active)]
        : candidates;
      const existing: string[] = [];
      for (const path of ordered) {
        if (!current()) return;
        if (excludedRestores.current.has(path)) continue;
        try {
          const file = await api<FileContent>(base + '/file?path=' + encodeURIComponent(path), {
            signal: controller.signal,
          });
          if (!current()) return;
          if (!file.binary && file.hash && !excludedRestores.current.has(path)) {
            existing.push(path);
            const combined = new Set([...tabsRef.current, path]);
            commit([
              ...candidates.filter((candidate) => combined.has(candidate)),
              ...tabsRef.current.filter((candidate) => !candidates.includes(candidate)),
            ]);
            if (!selected) {
              setActive(path);
              setSelectionReady(true);
              selectionResolved.current = true;
              selected = true;
            }
          }
        } catch (e) {
          if (!current()) return;
          if (!(typeof e === 'object' && e !== null && 'status' in e && e.status === 404)) throw e;
        }
      }
      if (!current()) return;
      // Starter files may not have been scaffolded yet; try again after preparation changes.
      if (
        !existing.length &&
        project.starterId &&
        ['pending', 'files'].includes(project.preparation.status)
      )
        return;
      if (!selected) setActive('');
      setSelectionReady(true);
      selectionResolved.current = true;
      setRestoreComplete(true);
      restored.current = true;
    })().catch((e) => {
      if (!current()) return;
      setRestoreError(errorMessage(e));
      // Background restoration must not cover an already usable selected file.
      if (selected) ui.notify(errorMessage(e));
    });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [project?.state, project?.preparation.status, attempt, backgroundAttempt]);
  useEffect(() => {
    if (!selectionReady || !restoreError || restoreComplete) return;
    const timer = setTimeout(() => setBackgroundAttempt((value) => value + 1), 2000);
    return () => clearTimeout(timer);
  }, [selectionReady, restoreError, restoreComplete, backgroundAttempt]);
  useEffect(() => {
    if (restored.current && !tabs.includes(active)) setActive(tabs.at(-1) || '');
  }, [tabs, active]);
  async function openFile(path: string, line?: number, column = 1) {
    const intent = ++fileIntent.current;
    try {
      const file = await api<FileContent>(base + `/file?path=${encodeURIComponent(path)}`);
      if (!mounted.current || intent !== fileIntent.current) return;
      if (file.binary) {
        ui.notify('This file is binary or larger than 2 MiB. Use Download from its file menu.');
        return;
      }
      // Once the initial file is chosen, a user selection need not cancel other saved tabs.
      if (!selectionResolved.current) {
        restored.current = true;
        setRestoreComplete(true);
      }
      setSelectionReady(true);
      selectionResolved.current = true;
      if (!tabsRef.current.includes(path)) commit([...tabsRef.current, path]);
      setActive(path);
      setSelection(line === undefined ? undefined : { line, column });
    } catch (e) {
      if (mounted.current && intent === fileIntent.current) ui.notify(errorMessage(e));
    }
  }
  async function closeTab(path: string) {
    fileIntent.current++;
    try {
      await flushOpenDocuments(id);
    } catch (e) {
      ui.notify(errorMessage(e));
      return;
    }
    if (!mounted.current) return;
    excludedRestores.current.add(path);
    delete positions.current[path];
    const remaining = tabsRef.current.filter((t) => t !== path);
    commit(remaining);
    setActive((current) => (current === path ? remaining.at(-1) || '' : current));
    viewStates.current.delete(path);
  }
  function selectTab(path: string) {
    fileIntent.current++;
    setActive(path);
    setSelection(undefined);
  }
  function dropPath(path: string) {
    applyStructure({ from: path });
  }
  function applyStructure(change: StructureChange) {
    fileIntent.current++;
    for (const path of saved.tabs) {
      if (remapPath(path, change) !== path) excludedRestores.current.add(path);
    }
    setStructure((changes) => [...changes, change]);
    const remaining = tabsRef.current
      .map((path) => remapPath(path, change))
      .filter((p): p is string => !!p);
    commit(remaining);
    setActive((v) => remapPath(v, change) || remaining.at(-1) || '');
    positions.current = Object.fromEntries(
      Object.entries(positions.current).flatMap(([path, pos]) => {
        const next = remapPath(path, change);
        return next ? [[next, pos]] : [];
      }),
    );
    viewStates.current = new Map(
      [...viewStates.current].flatMap(([path, state]) => {
        const next = remapPath(path, change);
        return next ? [[next, state]] : [];
      }),
    );
  }
  function observeDocument(doc: DocumentIdentity) {
    const previous = registry.current.documents.get(doc.id);
    if (previous && previous.revision > doc.revision) return;
    if (previous && previous.path !== doc.path)
      applyStructure({ from: previous.path, to: doc.path });
    registry.current.documents.set(doc.id, doc);
  }
  async function reconcileRegistry() {
    const next = await api<WorkspaceSnapshot>(base + '/workspace');
    if (!mounted.current || !Array.isArray(next.documents)) return;
    // A live document event can overtake this HTTP response. Never remap a newer identity backwards.
    const merged = next.documents.map((doc) => {
      const current = registry.current.documents.get(doc.id);
      return current && current.revision > doc.revision ? current : doc;
    });
    registry.current.reconcileDocuments(merged, (from, to) => applyStructure({ from, to }));
  }
  return {
    tabs,
    active,
    selection,
    structure,
    restored,
    selectionReady,
    restoreComplete,
    restoreError,
    positions,
    viewStates,
    openFile,
    closeTab,
    selectTab,
    dropPath,
    applyStructure,
    observeDocument,
    reconcileRegistry,
  };
}
