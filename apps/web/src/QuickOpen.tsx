import { useEffect, useState } from 'react';
import type { FileIndex } from '@repellet/shared';
import { api, errorMessage } from './api';
import { Modal } from './ui';
export function QuickOpen({
  projectId,
  revision,
  onOpen,
  onClose,
}: {
  projectId: string;
  revision: number;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [paths, setPaths] = useState<string[]>([]),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    api<FileIndex>(`/projects/${projectId}/file-index`)
      .then((v) => {
        if (!disposed) setPaths(v.paths);
      })
      .catch((e) => {
        if (!disposed) setError(errorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, [projectId, revision]);
  const results = paths
    .filter((path) =>
      query
        .toLowerCase()
        .split(/\s+/)
        .every((part) => path.toLowerCase().includes(part)),
    )
    .slice(0, 100);
  useEffect(() => {
    document.getElementById(`quick-file-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <Modal title="Open file" onClose={onClose}>
      <input
        autoFocus
        aria-label="Search file paths"
        value={query}
        placeholder="Search relative paths…"
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((v) =>
              Math.max(0, Math.min(results.length - 1, v + (e.key === 'ArrowDown' ? 1 : -1))),
            );
          }
          if (e.key === 'Enter' && results[selected]) {
            e.preventDefault();
            onOpen(results[selected]);
            onClose();
          }
        }}
        aria-controls="quick-open-results"
        aria-activedescendant={results[selected] ? `quick-file-${selected}` : undefined}
      />
      {error && <p role="alert">{error}</p>}
      <div className="quick-open-results" id="quick-open-results" role="listbox">
        {results.map((path, i) => (
          <button
            key={path}
            id={`quick-file-${i}`}
            role="option"
            aria-selected={i === selected}
            onClick={() => {
              onOpen(path);
              onClose();
            }}
          >
            {path}
          </button>
        ))}
        {!results.length && <p>No matching files.</p>}
      </div>
    </Modal>
  );
}
