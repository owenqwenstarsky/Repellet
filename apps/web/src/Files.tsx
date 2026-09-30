import { useState, useEffect, useRef } from 'react';
import type { FileEntry, SearchMatch } from '@repellet/shared';
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FilePlus2,
  FolderPlus,
  Upload,
  FolderUp,
  MoreHorizontal,
  Search,
  Replace,
  RefreshCw,
  Download,
  FileCode2,
  Braces,
} from 'lucide-react';
import { api, post, errorMessage } from './api';
import { useUi, Spinner, Dropdown } from './ui';
export function FileTree({
  projectId,
  active,
  onOpen,
  editable,
  revision,
}: {
  projectId: string;
  active: string;
  onOpen: (path: string, line?: number) => void;
  editable: boolean;
  revision: number;
}) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [selected, setSelected] = useState('');
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const upload = useRef<HTMLInputElement>(null);
  const uploadFolder = useRef<HTMLInputElement>(null);
  const ui = useUi();
  async function load(path = '') {
    try {
      const list = await api<FileEntry[]>(
        `/projects/${projectId}/files?path=${encodeURIComponent(path)}`,
      );
      setChildren((old) => ({ ...old, [path]: list }));
    } catch (e) {
      ui.notify(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    for (const p of expanded) void load(p);
  }, [projectId, revision]);
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
          style={{ paddingLeft: 12 + depth * 14 }}
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
        {entry.kind === 'directory' && expanded.has(entry.path) && rows(entry.path, depth + 1)}
      </div>
    ));
  }
  return (
    <>
      <div className="pane-heading">
        <span>FILES</span>
        <div>
          {editable && (
            <>
              <button
                className="icon-button"
                aria-label="New file"
                title="New file"
                onClick={() => create('file')}
              >
                <FilePlus2 size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="New folder"
                title="New folder"
                onClick={() => create('directory')}
              >
                <FolderPlus size={15} />
              </button>
              <button
                className="icon-button"
                aria-label="Upload files"
                title="Upload files"
                onClick={() => upload.current?.click()}
              >
                <Upload size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="Upload folder"
                title="Upload folder"
                onClick={() => uploadFolder.current?.click()}
              >
                <FolderUp size={14} />
              </button>
            </>
          )}
          <button
            className="icon-button"
            aria-label="Refresh files"
            onClick={() => {
              for (const p of expanded) void load(p);
            }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      <div
        className="file-tree"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setSelected('');
          }
        }}
      >
        {loading ? (
          <Spinner />
        ) : children['']?.length ? (
          rows('')
        ) : (
          <div className="tree-empty">
            No files yet.
            {editable && (
              <button className="text-button" onClick={() => create('file')}>
                Create a file
              </button>
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
          <div className="menu-dismiss" onClick={() => setMenu(null)} />
          <Dropdown
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
                        for (const p of expanded) void load(p);
                      } catch (e) {
                        ui.notify(errorMessage(e));
                      }
                  }}
                >
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
                        for (const p of expanded) void load(p);
                      } catch (e) {
                        ui.notify(errorMessage(e));
                      }
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </Dropdown>
        </>
      )}
    </>
  );
}
export function FileIcon({ name }: { name: string }) {
  const extension = name.split('.').pop();
  return <FileCode2 size={15} className={`file-icon ext-${extension}`} />;
}
export function SearchPane({
  projectId,
  editable,
  onOpen,
}: {
  projectId: string;
  editable: boolean;
  onOpen: (p: string, line: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const ui = useUi();
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [projectId],
  );
  async function search() {
    if (!query) return;
    const version = ++request.current;
    setBusy(true);
    try {
      const results = await api<SearchMatch[]>(
        `/projects/${projectId}/search?query=${encodeURIComponent(query)}`,
      );
      if (version !== request.current) return;
      setMatches(results);
      setSearched(true);
    } catch (e) {
      if (version === request.current) ui.notify(errorMessage(e));
    } finally {
      if (version === request.current) setBusy(false);
    }
  }
  return (
    <div className="search-pane">
      <div className="pane-heading">SEARCH</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="sr-only" htmlFor="file-search">
          Find in project
        </label>
        <input
          id="file-search"
          autoFocus
          value={query}
          onChange={(e) => {
            request.current++;
            setBusy(false);
            setSearched(false);
            setMatches([]);
            setQuery(e.target.value);
          }}
          placeholder="Find in project…"
        />
        {editable && (
          <input
            aria-label="Replacement"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Replace with…"
          />
        )}
        <div className="search-actions">
          <button className="button secondary small" disabled={!query || busy}>
            <Search size={14} />
            Search
          </button>
          {editable && (
            <button
              type="button"
              className="button secondary small"
              disabled={!query || busy}
              onClick={async () => {
                if (
                  !(await ui.ask({
                    title: 'Replace in project?',
                    description: `Replace every occurrence of “${query}” in matching text files?`,
                    confirm: true,
                  }))
                )
                  return;
                setBusy(true);
                try {
                  const result = await post(`/projects/${projectId}/replace`, {
                    query,
                    replacement,
                  });
                  ui.notify(`Updated ${result.files} files.`, 'success');
                  void search();
                } catch (e) {
                  ui.notify(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Replace size={14} />
              Replace all
            </button>
          )}
        </div>
      </form>
      {busy ? (
        <Spinner />
      ) : (
        searched && (
          <div className="search-results">
            <p className="field-help">
              {matches.length} matches{matches.length >= 300 ? ' (showing first 300)' : ''}
            </p>
            {matches.map((m, i) => (
              <button key={i} onClick={() => onOpen(m.path, m.line)}>
                <span>
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
