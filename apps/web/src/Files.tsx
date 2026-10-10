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
    const name = await ui.ask({
      title: kind === 'file' ? 'New file' : 'New folder',
      label: 'Workspace path',
      value: directory ? directory + '/' : '',
    });
    if (!name) return;
    try {
      await post(`/projects/${projectId}/files/create`, { path: name, kind });
      await load(directory);
      if (kind === 'file') onOpen(name);
    } catch (e) {
      ui.notify(errorMessage(e));
    }
  }
  async function uploadSelection(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    for (const file of input.files || []) {
      if (file.size > 8 * 1024 * 1024) {
        ui.notify(`${file.name}: uploads are limited to 8 MiB.`);
        continue;
      }
      try {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let data = '';
        for (const byte of buffer) data += String.fromCharCode(byte);
        await post(`/projects/${projectId}/files/upload`, {
          path: [directory, file.webkitRelativePath || file.name].filter(Boolean).join('/'),
          data: btoa(data),
        });
      } catch (error) {
        ui.notify(errorMessage(error));
      }
    }
    input.value = '';
    await load(directory);
  }
  function rows(path: string, depth = 0): React.ReactNode {
    return (children[path] || []).map((entry) => (
      <div key={entry.path}>
        <button
          className={`file-row ${active === entry.path ? 'active' : ''} ${selected === entry.path ? 'selected' : ''}`}
          style={{ paddingLeft: `min(${12 + depth * 14}px, max(12px, calc(100% - 120px)))` }}
          title={entry.path}
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
                  label="New file"
                  icon={<FilePlus2 size={14} />}
                  onClick={() => create('file')}
                />
                <IconButton
                  size="sm"
                  label="New folder"
                  icon={<FolderPlus size={14} />}
                  onClick={() => create('directory')}
                />
                <MenuButton label="Upload" icon={<Upload size={14} />} className="pane-menu">
                  <MenuItem icon={<Upload size={14} />} onSelect={() => upload.current?.click()}>
                    Upload files…
                  </MenuItem>
                  <MenuItem
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
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setSelected('');
          }
        }}
      >
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
              <Button variant="link" size="sm" onClick={() => create('file')}>
                Create a file
              </Button>
            )}
          </div>
        )}
      </div>
      <input ref={upload} type="file" multiple className="hidden" onChange={uploadSelection} />
      <input
        ref={uploadFolder}
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
                  onClick={async () => {
                    setMenu(null);
                    const to = await ui.ask({
                      title: 'Rename or move',
                      label: 'Workspace path',
                      value: menu.path,
                    });
                    if (to && to !== menu.path)
                      try {
                        await post(`/projects/${projectId}/files/move`, { from: menu.path, to });
                      } catch (e) {
                        ui.notify(errorMessage(e));
                      }
                  }}
                >
                  <Pencil size={14} />
                  Rename / move
                </button>
                <button
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
                      try {
                        await post(`/projects/${projectId}/files/delete`, { path: menu.path });
                      } catch (e) {
                        ui.notify(errorMessage(e));
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
