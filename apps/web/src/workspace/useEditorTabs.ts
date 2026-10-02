import { useEffect, useRef, useState, type RefObject } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { FileContent, Project, WorkspacePreferences } from '@repellet/shared';
import { starterCatalog } from '@repellet/shared';
import { api, errorMessage } from '../api';
import { useUi } from '../ui';
import { flushOpenDocuments } from '../documentSaves';
import { remapPath, type StructureChange } from '../workspaceState';
// Open editor tabs, the active file and per-file view state, including restore after reload.
export function useEditorTabs(
  id: string,
  saved: WorkspacePreferences,
  project: Project | null,
  mounted: RefObject<boolean>,
) {
  const ui = useUi();
  const base = `/projects/${id}`;
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [selection, setSelection] = useState<{ line: number; column: number }>();
  const [structure, setStructure] = useState<StructureChange[]>([]);
  const restored = useRef(false);
  const positions = useRef(saved.positions);
  const viewStates = useRef(new Map<string, MonacoEditor.ICodeEditorViewState>());
  const fileIntent = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  function commit(next: string[]) {
    tabsRef.current = next;
    setTabs(next);
  }
  useEffect(() => {
    if (project?.state !== 'running' || restored.current) return;
    let disposed = false;
    const version = fileIntent.current;
    void (async () => {
      const initialFile = starterCatalog.find((s) => s.id === project.starterId)?.initialFile;
      const candidates = saved.tabs.length ? saved.tabs : initialFile ? [initialFile] : [];
      const existing: string[] = [];
      for (const path of candidates) {
        try {
          const file = await api<FileContent>(base + '/file?path=' + encodeURIComponent(path));
          if (!file.binary && file.hash) existing.push(path);
        } catch {}
      }
      if (disposed || restored.current || version !== fileIntent.current) return;
      // Starter files may not have been scaffolded yet; try again after preparation changes.
      if (
        !existing.length &&
        project.starterId &&
        ['pending', 'files'].includes(project.preparation.status)
      )
        return;
      commit(existing);
      setActive(existing.includes(saved.active) ? saved.active : existing[0] || '');
      restored.current = true;
    })().catch((e) => ui.notify(errorMessage(e)));
    return () => {
      disposed = true;
    };
  }, [project?.state, project?.preparation.status]);
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
      restored.current = true;
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
  return {
    tabs,
    active,
    selection,
    structure,
    restored,
    positions,
    viewStates,
    openFile,
    closeTab,
    selectTab,
    dropPath,
    applyStructure,
  };
}
