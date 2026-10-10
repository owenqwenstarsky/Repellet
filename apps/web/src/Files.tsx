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
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverPath = useRef<string | null>(null);
  const operationProject = useRef(projectId);
  operationProject.current = projectId;
  function clearDrag(clearSource = true) {
    if (hover.current) clearTimeout(hover.current);
    hover.current = null;
    hoverPath.current = null;
    if (clearSource) dragSource.current = null;
    setDropTarget(null);
  }
  useEffect(() => {
    operationProject.current = projectId;
    clearDrag();
    const cancel = () => clearDrag();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearDrag();
    };
    window.addEventListener('dragend', cancel);
    window.addEventListener('drop', cancel);
    window.addEventListener('keydown', key);
    return () => {
      operationProject.current = '';
      if (hover.current) clearTimeout(hover.current);
      window.removeEventListener('dragend', cancel);
      window.removeEventListener('drop', cancel);
      window.removeEventListener('keydown', key);
    };
  }, [projectId]);
  function dragOver(event: React.DragEvent, target: string) {
    const types = Array.from(event.dataTransfer.types);
    const internal = types.includes(workspaceDragType);
    if (!internal && !types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    const source = dragSource.current;
    if (
      !editable ||
      mutation.current ||
      (internal && source && !canMove(source, projectId, target))
    ) {
      event.dataTransfer.dropEffect = 'none';
      setDropTarget(null);
      if (hover.current) clearTimeout(hover.current);
      hoverPath.current = null;
      return;
    }
    event.dataTransfer.dropEffect = internal ? 'move' : 'copy';
    setDropTarget({ path: target, mode: internal ? 'Move' : 'Upload' });
    if (hoverPath.current !== target) {
      if (hover.current) clearTimeout(hover.current);
      hoverPath.current = target;
      if (target && !expandedRef.current.has(target))
        hover.current = setTimeout(() => {
          setExpanded((old) => new Set([...old, target]));
          void load(target);
        }, 600);
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
    clearDrag();
    if (!editable || mutation.current) return;
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
          draggable={editable && !busy}
          onDragStart={(event) => {
            if (!editable || mutation.current) {
              event.preventDefault();
              return;
            }
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
        className="file-tree"
        aria-busy={busy}
        onDragOver={(event) => dragOver(event, '')}
        onDrop={(event) => drop(event, '')}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearDrag(false);
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
          onClick={() => setSelected('')}
          onDragOver={(event) => dragOver(event, '')}
          onDrop={(event) => drop(event, '')}
        >
          <Folder size={15} />
          <span>Workspace root</span>
        </button>
        {(dropTarget || progress) && (
          <div className="file-drop-status" role="status">
            {progress || `${dropTarget!.mode} to ${dropTarget!.path || 'Workspace root'}`}
          </div>
        )}
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
