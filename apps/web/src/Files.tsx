import { useState, useEffect, useRef } from 'react';
import type { FileEntry, SearchMatch } from '@repellet/shared';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FilePlus2,
  FolderPlus,
  Upload,
  FolderUp,
  Search,
  Replace,
  RefreshCw,
  Download,
  FileCode2,
  FileJson,
  FileText,
  FileImage,
  Pencil,
  Trash2,
} from 'lucide-react';
import { api, post, errorMessage } from './api';
import {
  useUi,
  Spinner,
  Menu,
  MenuButton,
  MenuItem,
  LoadError,
  PaneHeader,
  IconButton,
  Button,
} from './ui';
import { remapPath, type StructureChange } from './workspaceState';
import {
  workspaceDragType,
  readWorkspaceDrag,
  canMove,
  droppedItems,
  parentPath,
  joinPath,
  type WorkspaceDrag,
  type UploadItem,
} from './fileDrag';
export function FileTree({
  projectId,
  active,
  onOpen,
  editable,
  revision,
  visible = true,
  structure,
  initialLoadAttempt = 0,
  onInitialLoad,
}: {
  projectId: string;
  active: string;
  onOpen: (path: string, line?: number) => void;
  editable: boolean;
  revision: number;
  visible?: boolean;
  structure?: StructureChange | StructureChange[];
  initialLoadAttempt?: number;
  onInitialLoad?: (error?: string) => void;
}) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [selected, setSelected] = useState('');
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const rootLoaded = useRef(false);
  const initialLoadCallback = useRef(onInitialLoad);
  initialLoadCallback.current = onInitialLoad;
  const controller = useRef<AbortController | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const epoch = useRef(0);
  const requests = useRef(new Map<string, number>());
  const lastStructure = useRef<StructureChange | StructureChange[] | undefined>(undefined);
  const structureCount = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const upload = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef<HTMLInputElement>(null);
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  const [progress, setProgress] = useState('');
  const [dropTarget, setDropTarget] = useState<{ path: string; mode: 'Move' | 'Upload' } | null>(
    null,
  );
  const dragSource = useRef<WorkspaceDrag | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const destination = useRef<typeof dropTarget>(null);
  const dragCancelled = useRef(false);
  const dragDepth = useRef(0);
  const pointer = useRef<{ x: number; y: number; mode: 'Move' | 'Upload' } | null>(null);
  const scrollAnimation = useRef<number | null>(null);
  const scrollTime = useRef<number | null>(null);
  const scrollFrame = useRef<(time: number) => void>(() => {});
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverPath = useRef<string | null>(null);
  const dragStructure = useRef(structure);
  const operationProject = useRef(projectId);
  operationProject.current = projectId;
  function stopDragWork() {
    if (hover.current !== null) clearTimeout(hover.current);
    hover.current = null;
    hoverPath.current = null;
    if (scrollAnimation.current !== null) cancelAnimationFrame(scrollAnimation.current);
    scrollAnimation.current = null;
    scrollTime.current = null;
    pointer.current = null;
  }
  function showDestination(next: typeof dropTarget) {
    if (destination.current?.path === next?.path && destination.current?.mode === next?.mode)
      return;
    destination.current = next;
    setDropTarget(next);
  }
  function clearDrag(clearSource = true) {
    stopDragWork();
    dragDepth.current = 0;
    if (clearSource) dragSource.current = null;
    showDestination(null);
  }
  function cancelDrag() {
    dragCancelled.current = true;
    clearDrag();
  }
  useEffect(() => {
    operationProject.current = projectId;
    clearDrag();
    const cancel = () => clearDrag();
    const blur = () => cancelDrag();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelDrag();
    };
    const outside = (event: DragEvent) => {
      if (tree.current && !tree.current.contains(event.target as Node | null)) clearDrag(false);
    };
    const outsideDrop = (event: DragEvent) => {
      if (tree.current && !tree.current.contains(event.target as Node | null)) clearDrag();
    };
    window.addEventListener('dragend', cancel);
    window.addEventListener('drop', cancel);
    window.addEventListener('drop', outsideDrop, true);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', key);
    window.addEventListener('dragover', outside, true);
    return () => {
      operationProject.current = '';
      dragCancelled.current = true;
      stopDragWork();
      window.removeEventListener('dragend', cancel);
      window.removeEventListener('drop', cancel);
      window.removeEventListener('drop', outsideDrop, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', key);
      window.removeEventListener('dragover', outside, true);
    };
  }, [projectId]);
  useEffect(() => {
    if ((!visible || !editable || busy) && (dragSource.current || pointer.current)) cancelDrag();
  }, [visible, editable, busy]);
  useEffect(() => {
    const previous = dragStructure.current;
    dragStructure.current = structure;
    const source = dragSource.current;
    if (!source) return;
    const changes =
      structure && structure !== previous
        ? Array.isArray(structure)
          ? structure.slice(Array.isArray(previous) ? previous.length : 0)
          : [structure]
        : [];
    const siblings = children[parentPath(source.path)];
    if (
      changes.some((change) => remapPath(source.path, change) !== source.path) ||
      (siblings && !siblings.some((entry) => entry.path === source.path))
    )
      cancelDrag();
  }, [children, structure]);
  function updateDestination(mode: 'Move' | 'Upload', target: string) {
    const source = dragSource.current;
    if (
      dragCancelled.current ||
      !visible ||
      !editable ||
      mutation.current ||
      (mode === 'Move' && (!source || !canMove(source, projectId, target)))
    ) {
      showDestination(null);
      if (hover.current !== null) clearTimeout(hover.current);
      hover.current = null;
      hoverPath.current = null;
      return false;
    }
    showDestination({ path: target, mode });
    if (hoverPath.current !== target) {
      if (hover.current !== null) clearTimeout(hover.current);
      hover.current = null;
      hoverPath.current = target;
      if (target && !expandedRef.current.has(target))
        hover.current = setTimeout(() => {
          hover.current = null;
          if (expandedRef.current.has(target)) return;
          const next = new Set([...expandedRef.current, target]);
          expandedRef.current = next;
          setExpanded(next);
          void load(target);
        }, 1500);
    }
    return true;
  }
  function targetAtPoint(x: number, y: number): string | null {
    const element = document.elementFromPoint?.(x, y);
    if (!element || !tree.current?.contains(element)) return null;
    return element.closest<HTMLElement>('[data-drop-directory]')?.dataset.dropDirectory ?? '';
  }
  function scrollSpeed() {
    const element = tree.current;
    const point = pointer.current;
    if (!element || !point || element.scrollHeight <= element.clientHeight) return 0;
    const bounds = element.getBoundingClientRect();
    if (
      point.x < bounds.left ||
      point.x >= bounds.right ||
      point.y < bounds.top ||
      point.y >= bounds.bottom
    )
      return 0;
    const zone = Math.min(32, bounds.height / 2);
    if (point.y < bounds.top + zone && element.scrollTop > 0)
      return -480 * (1 - (point.y - bounds.top) / zone);
    if (
      point.y > bounds.bottom - zone &&
      element.scrollTop < element.scrollHeight - element.clientHeight
    )
      return 480 * (1 - (bounds.bottom - point.y) / zone);
    return 0;
  }
  scrollFrame.current = (time) => {
    scrollAnimation.current = null;
    const point = pointer.current;
    const element = tree.current;
    const speed = scrollSpeed();
    if (!point || !element || !speed) {
      scrollTime.current = null;
      return;
    }
    const elapsed = scrollTime.current === null ? 0 : Math.min(32, time - scrollTime.current);
    scrollTime.current = time;
    element.scrollTop = Math.max(
      0,
      Math.min(
        element.scrollHeight - element.clientHeight,
        element.scrollTop + (speed * elapsed) / 1000,
      ),
    );
    const target = targetAtPoint(point.x, point.y);
    if (target === null) {
      clearDrag(false);
      return;
    }
    updateDestination(point.mode, target);
    scrollAnimation.current = requestAnimationFrame((next) => scrollFrame.current(next));
  };
  function dragOver(event: React.DragEvent, target: string) {
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes(workspaceDragType) && !types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    // Local uploads have no dragstart in this tree. A new entry starts their session.
    if (!types.includes(workspaceDragType) && !pointer.current && !dragCancelled.current)
      dragDepth.current = Math.max(1, dragDepth.current);
    const mode = types.includes(workspaceDragType) ? 'Move' : 'Upload';
    const allowed = updateDestination(mode, target);
    event.dataTransfer.dropEffect = allowed ? (mode === 'Move' ? 'move' : 'copy') : 'none';
    if (dragCancelled.current || !visible || !editable || mutation.current) return;
    pointer.current = { x: event.clientX, y: event.clientY, mode };
    if (scrollSpeed() && scrollAnimation.current === null)
      scrollAnimation.current = requestAnimationFrame((time) => scrollFrame.current(time));
    else if (!scrollSpeed() && scrollAnimation.current !== null) {
      cancelAnimationFrame(scrollAnimation.current);
      scrollAnimation.current = null;
      scrollTime.current = null;
    }
  }
  async function move(from: string, to: string) {
    if (!editable || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    const project = projectId;
    try {
      await post(`/projects/${project}/files/move`, { from, to });
      if (operationProject.current === project) {
        await Promise.all(
          [...new Set([parentPath(from), parentPath(to)])].map((path) => load(path)),
        );
      }
    } catch (e) {
      if (operationProject.current === project) ui.notify(errorMessage(e));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function uploadItems(items: Promise<UploadItem[]> | UploadItem[], target: string) {
    if (!editable || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setProgress('Reading upload…');
    const project = projectId;
    let completed = 0,
      failed = 0;
    const refresh = new Set([target]);
    try {
      const entries = await items;
      for (let i = 0; i < entries.length; i++) {
        if (operationProject.current !== project) break;
        const { path, file } = entries[i];
        const destination = joinPath(target, path);
        setProgress(`Uploading ${i + 1} of ${entries.length}…`);
        try {
          if (file) {
            if (file.size > 8 * 1024 * 1024) throw new Error('uploads are limited to 8 MiB.');
            const buffer = new Uint8Array(await file.arrayBuffer());
            let data = '';
            for (const byte of buffer) data += String.fromCharCode(byte);
            if (operationProject.current !== project) break;
            await post(`/projects/${project}/files/upload`, {
              path: destination,
              data: btoa(data),
            });
          } else {
            try {
              await post(`/projects/${project}/files/create`, {
                path: destination,
                kind: 'directory',
              });
            } catch (error) {
              // Existing directories can receive new contents; files are never overwritten.
              try {
                await api(`/projects/${project}/files?path=${encodeURIComponent(destination)}`);
              } catch {
                throw error;
              }
            }
          }
          completed++;
          refresh.add(parentPath(destination));
        } catch (error) {
          failed++;
          if (operationProject.current === project) ui.notify(`${path}: ${errorMessage(error)}`);
        }
      }
      if (operationProject.current === project) {
        ui.notify(
          `Upload complete: ${completed} items completed, ${failed} failed or skipped.`,
          failed ? undefined : 'success',
        );
      }
    } catch (error) {
      if (operationProject.current === project) ui.notify(errorMessage(error));
    } finally {
      if (operationProject.current === project) {
        await Promise.all(
          [...refresh]
            .filter((path) => path === target || expandedRef.current.has(path))
            .map((path) => load(path)),
        );
      }
      mutation.current = false;
      setBusy(false);
      setProgress('');
    }
  }
  function drop(event: React.DragEvent, target: string) {
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes(workspaceDragType) && !types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    const source = readWorkspaceDrag(event.dataTransfer);
    const cancelled = dragCancelled.current;
    // Scrolling can change the row under a stationary pointer before the next native event.
    if (scrollTime.current !== null) target = targetAtPoint(event.clientX, event.clientY) ?? target;
    clearDrag();
    if (cancelled || !visible || !editable || mutation.current) return;
    if (types.includes(workspaceDragType)) {
      if (source && canMove(source, projectId, target))
        void move(source.path, joinPath(target, source.path.split('/').pop()!));
    } else void uploadItems(droppedItems(event.dataTransfer), target);
  }

  async function load(path = '') {
    const generation = epoch.current;
    const request = (requests.current.get(path) || 0) + 1;
    requests.current.set(path, request);
    const current = () => generation === epoch.current && requests.current.get(path) === request;
    try {
      const list = await api<FileEntry[]>(
        `/projects/${projectId}/files?path=${encodeURIComponent(path)}`,
        { signal: controller.current?.signal },
      );
      if (!current()) return;
      setErrors((old) => {
        const next = { ...old };
        delete next[path];
        return next;
      });
      setChildren((old) => ({ ...old, [path]: list }));
      if (path === '') {
        rootLoaded.current = true;
        initialLoadCallback.current?.();
      }
    } catch (e) {
      if (current()) {
        const message = errorMessage(e);
        setErrors((old) => ({ ...old, [path]: message }));
        if (path === '' && !rootLoaded.current) initialLoadCallback.current?.(message);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }
  useEffect(() => {
    epoch.current++;
    const abort = new AbortController();
    controller.current = abort;
    let paths = expandedRef.current;
    if (structure && structure !== lastStructure.current) {
      lastStructure.current = structure;
      const changes = Array.isArray(structure)
        ? structure.slice(structureCount.current)
        : [structure];
      if (Array.isArray(structure)) structureCount.current = structure.length;
      for (const change of changes) {
        paths = new Set(
          [...paths].map((p) => remapPath(p, change)).filter((p): p is string => p !== null),
        );
        setSelected((p) => remapPath(p, change) || '');
      }
      paths.add('');
      expandedRef.current = paths;
      setExpanded(paths);
      setChildren({});
      setErrors({});
      setMenu(null);
    }
    if (visible) for (const p of paths) void load(p);
    else if (!rootLoaded.current && onInitialLoad) void load('');
    return () => {
      epoch.current++;
      abort.abort();
    };
  }, [projectId, revision, visible, structure, initialLoadAttempt]);
  const directory = selected
    ? Object.values(children)
        .flat()
        .find((e) => e.path === selected)?.kind === 'directory'
      ? selected
      : selected.split('/').slice(0, -1).join('/')
    : '';
  async function create(kind: 'file' | 'directory') {
    if (!editable || mutation.current) return;
    const name = await ui.ask({
      title: kind === 'file' ? 'New file' : 'New folder',
      label: 'Workspace path',
      value: directory ? directory + '/' : '',
    });
    if (!name || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try {
      await post(`/projects/${projectId}/files/create`, { path: name, kind });
      await load(directory);
      if (kind === 'file') onOpen(name);
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function uploadSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files || []).map((file) => ({
      path: file.webkitRelativePath || file.name,
      file,
    }));
    input.value = '';
    await uploadItems(files, directory);
  }
  function rows(path: string, depth = 0): React.ReactNode {
    return (children[path] || []).map((entry) => (
      <div key={entry.path}>
        <button
          className={`file-row ${active === entry.path ? 'active' : ''} ${selected === entry.path ? 'selected' : ''} ${dropTarget?.path === entry.path ? 'drop-target' : ''}`}
          style={{ paddingLeft: `min(${12 + depth * 14}px, max(12px, calc(100% - 120px)))` }}
          title={entry.path}
          data-drop-directory={entry.kind === 'directory' ? entry.path : parentPath(entry.path)}
          draggable={editable && !busy}
          onDragStart={(event) => {
            if (!editable || mutation.current) {
              event.preventDefault();
              return;
            }
            clearDrag();
            dragCancelled.current = false;
            const source = { projectId, path: entry.path, kind: entry.kind };
            dragSource.current = source;
            event.dataTransfer.setData(workspaceDragType, JSON.stringify(source));
            event.dataTransfer.effectAllowed = 'move';
          }}
          onDragEnd={() => clearDrag()}
          onDragOver={(event) =>
            dragOver(event, entry.kind === 'directory' ? entry.path : parentPath(entry.path))
          }
          onDrop={(event) =>
            drop(event, entry.kind === 'directory' ? entry.path : parentPath(entry.path))
          }
          aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined}
          aria-current={active === entry.path ? 'true' : undefined}
          onClick={() => {
            setSelected(entry.path);
            if (entry.kind === 'directory') {
              setExpanded((old) => {
                const next = new Set(old);
                next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
                return next;
              });
              if (!expanded.has(entry.path)) void load(entry.path);
            } else onOpen(entry.path);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              const bounds = e.currentTarget.getBoundingClientRect();
              setSelected(entry.path);
              setMenu({ path: entry.path, x: bounds.left + 20, y: bounds.bottom });
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.currentTarget.focus();
            setSelected(entry.path);
            setMenu({ path: entry.path, x: e.clientX, y: e.clientY });
          }}
        >
          {entry.kind === 'directory' ? (
            <>
              {expanded.has(entry.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <Folder size={15} className="folder-color" />
            </>
          ) : (
            <>
              <span className="tree-spacer" />
              <FileIcon name={entry.name} />
            </>
          )}
          <span>{entry.name}</span>
          {entry.kind === 'symlink' && <small>↗</small>}
        </button>
        {entry.kind === 'directory' &&
          expanded.has(entry.path) &&
          (errors[entry.path] ? (
            <LoadError message={errors[entry.path]!} onRetry={() => load(entry.path)} />
          ) : (
            rows(entry.path, depth + 1)
          ))}
      </div>
    ));
  }
  return (
    <>
      <PaneHeader
        title="Files"
        actions={
          <>
            {editable && (
              <>
                <IconButton
                  size="sm"
                  disabled={busy}
                  label="New file"
                  icon={<FilePlus2 size={14} />}
                  onClick={() => create('file')}
                />
                <IconButton
                  size="sm"
                  disabled={busy}
                  label="New folder"
                  icon={<FolderPlus size={14} />}
                  onClick={() => create('directory')}
                />
                <MenuButton label="Upload" icon={<Upload size={14} />} className="pane-menu">
                  <MenuItem
                    disabled={busy}
                    icon={<Upload size={14} />}
                    onSelect={() => upload.current?.click()}
                  >
                    Upload files…
                  </MenuItem>
                  <MenuItem
                    disabled={busy}
                    icon={<FolderUp size={14} />}
                    onSelect={() => uploadFolder.current?.click()}
                  >
                    Upload folder…
                  </MenuItem>
                </MenuButton>
              </>
            )}
            <IconButton
              size="sm"
              label="Refresh files"
              icon={<RefreshCw size={13} />}
              onClick={() => {
                for (const p of expanded) void load(p);
              }}
            />
          </>
        }
      />
      <div
        ref={tree}
        className="file-tree"
        aria-busy={busy}
        onDragOver={(event) => dragOver(event, '')}
        onDrop={(event) => drop(event, '')}
        onDragEnterCapture={(event) => {
          const types = Array.from(event.dataTransfer.types);
          if (!types.includes(workspaceDragType) && !types.includes('Files')) return;
          if (dragDepth.current === 0 && !types.includes(workspaceDragType))
            dragCancelled.current = false;
          dragDepth.current++;
        }}
        onDragLeaveCapture={(event) => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          const related = event.relatedTarget as Node | null;
          if (related && event.currentTarget.contains(related)) return;
          if (!related && targetAtPoint(event.clientX, event.clientY) !== null) return;
          if (related || dragDepth.current === 0) clearDrag(false);
        }}
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setSelected('');
          }
        }}
      >
        <button
          className={`file-row workspace-root ${dropTarget?.path === '' ? 'drop-target' : ''}`}
          data-drop-directory=""
          onClick={() => setSelected('')}
          onDragOver={(event) => dragOver(event, '')}
          onDrop={(event) => drop(event, '')}
        >
          <Folder size={15} />
          <span>Workspace root</span>
        </button>
        {errors[''] ? (
          <LoadError message={errors['']!} onRetry={() => load()} />
        ) : loading ? (
          <Spinner />
        ) : children['']?.length ? (
          rows('')
        ) : (
          <div className="tree-empty">
            No files yet.
            {editable && (
              <Button disabled={busy} variant="link" size="sm" onClick={() => create('file')}>
                Create a file
              </Button>
            )}
          </div>
        )}
      </div>
      <div
        className="file-drop-status"
        role={dropTarget || progress ? 'status' : undefined}
        aria-live="polite"
        aria-atomic="true"
        title={
          progress ||
          (dropTarget ? `${dropTarget.mode} to ${dropTarget.path || 'Workspace root'}` : '')
        }
      >
        {progress ||
          (dropTarget ? `${dropTarget.mode} to ${dropTarget.path || 'Workspace root'}` : '')}
      </div>
      <input
        ref={upload}
        disabled={busy || !editable}
        type="file"
        multiple
        className="hidden"
        onChange={uploadSelection}
      />
      <input
        ref={uploadFolder}
        disabled={busy || !editable}
        type="file"
        multiple
        className="hidden"
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={uploadSelection}
      />
      {menu && (
        <>
          <Menu
            onClose={() => setMenu(null)}
            className="context-menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 160),
            }}
          >
            <button
              onClick={() => {
                window.open(
                  `/api/projects/${projectId}/files/download?path=${encodeURIComponent(menu.path)}`,
                  '_blank',
                  'noopener',
                );
                setMenu(null);
              }}
            >
              <Download size={14} />
              Download
            </button>
            {editable && (
              <>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setMenu(null);
                    const to = await ui.ask({
                      title: 'Rename or move',
                      label: 'Workspace path',
                      value: menu.path,
                    });
                    if (to && to !== menu.path)
                      try {
                        await move(menu.path, to);
                      } catch (e) {
                        ui.notify(errorMessage(e));
                      }
                  }}
                >
                  <Pencil size={14} />
                  Rename / move
                </button>
                <button
                  disabled={busy}
                  className="danger-text"
                  onClick={async () => {
                    setMenu(null);
                    if (
                      await ui.ask({
                        title: 'Delete file or folder?',
                        description: `Permanently delete ${menu.path}?`,
                        confirm: true,
                        danger: true,
                      })
                    )
                      if (!mutation.current)
                        try {
                          mutation.current = true;
                          setBusy(true);
                          await post(`/projects/${projectId}/files/delete`, { path: menu.path });
                        } catch (e) {
                          ui.notify(errorMessage(e));
                        } finally {
                          mutation.current = false;
                          setBusy(false);
                        }
                  }}
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </>
            )}
          </Menu>
        </>
      )}
    </>
  );
}
const code =
  /^(c|cc|cpp|cs|css|go|h|html|java|js|jsx|kt|mjs|php|py|rb|rs|scss|sh|sql|svelte|swift|ts|tsx|vue)$/;
export function FileIcon({ name }: { name: string }) {
  const extension = (name.includes('.') ? name.split('.').pop() || '' : '').toLowerCase();
  const Icon = code.test(extension)
    ? FileCode2
    : ['json', 'jsonc', 'yaml', 'yml', 'toml'].includes(extension)
      ? FileJson
      : ['md', 'mdx', 'txt', 'rst'].includes(extension)
        ? FileText
        : ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(extension)
          ? FileImage
          : File;
  return <Icon size={14} className={`file-icon ext-${extension}`} aria-hidden="true" />;
}
export function SearchPane({
  projectId,
  editable,
  onOpen,
  visible = true,
}: {
  projectId: string;
  visible?: boolean;
  editable: boolean;
  onOpen: (p: string, line: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [error, setError] = useState('');
  const intent = useRef(0);
  const mutation = useRef(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const ui = useUi();
  useEffect(
    () => () => {
      intent.current++;
    },
    [],
  );
  async function search(value = query) {
    if (!value) return;
    const request = ++intent.current;
    setSearching(true);
    setError('');
    try {
      const results = await api<SearchMatch[]>(
        `/projects/${projectId}/search?query=${encodeURIComponent(value)}`,
      );
      if (request !== intent.current || value !== queryRef.current) return;
      setMatches(results);
      setSubmitted(value);
    } catch (e) {
      if (request === intent.current) setError(errorMessage(e));
    } finally {
      if (request === intent.current) setSearching(false);
    }
  }
  async function replaceAll() {
    if (mutation.current || !query) return;
    mutation.current = true;
    setReplacing(true);
    const values = { query, replacement };
    try {
      if (
        !(await ui.ask({
          title: 'Replace in project?',
          description: `Replace every occurrence of “${values.query}” in matching text files?`,
          confirm: true,
        }))
      )
        return;
      const result = await post(`/projects/${projectId}/replace`, values);
      ui.notify(
        `Updated ${result.files} files.${result.skippedFiles?.length ? ` Skipped ${result.skippedFiles.length} binary or oversized files.` : ''}`,
        'success',
      );
      await search(queryRef.current);
    } catch (e) {
      ui.notify(errorMessage(e));
      await search(queryRef.current);
    } finally {
      mutation.current = false;
      setReplacing(false);
    }
  }
  useEffect(() => {
    if (visible && submitted === query && query && !mutation.current) void search();
  }, [visible, projectId]);
  const busy = searching || replacing;
  return (
    <div className="search-pane">
      <PaneHeader title="Search" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!replacing) void search();
        }}
      >
        <label className="sr-only" htmlFor="file-search">
          Find in project
        </label>
        <input
          id="file-search"
          value={query}
          maxLength={1000}
          onChange={(e) => {
            intent.current++;
            setSearching(false);
            setSubmitted(null);
            setError('');
            setQuery(e.target.value);
          }}
          placeholder="Find in project…"
        />
        {editable && (
          <input
            aria-label="Replacement"
            value={replacement}
            maxLength={10000}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with…"
          />
        )}
        <div className="search-actions">
          <Button type="submit" size="sm" disabled={!query || busy} icon={<Search size={13} />}>
            Search
          </Button>
          {editable && (
            <Button
              size="sm"
              disabled={!query || busy}
              onClick={replaceAll}
              icon={<Replace size={13} />}
            >
              Replace all
            </Button>
          )}
        </div>
      </form>
      {error && <LoadError message={error} onRetry={() => search()} />}
      {busy ? (
        <Spinner />
      ) : (
        submitted === query && (
          <div className="search-results">
            <p className="field-help">
              {matches.length} matches{matches.length >= 300 ? ' (showing first 300)' : ''} for “
              {submitted}”
            </p>
            {matches.map((m, i) => (
              <button key={i} onClick={() => onOpen(m.path, m.line)}>
                <span title={`${m.path}:${m.line}`}>
                  {m.path}:{m.line}
                </span>
                <code>{m.text}</code>
              </button>
            ))}
          </div>
        )
      )}
    </div>
  );
}
