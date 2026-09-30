export function panelDimensions(
  width: number,
  height: number,
  requested: {
    explorer: number;
    preview: number;
    terminal: number;
  },
  showPreview: boolean,
  showTerminal: boolean,
) {
  // Activity bar and vertical separators occupy 45 + 5 (+ 5) pixels.
  const available = Math.max(0, width - 45 - 5 - (showPreview ? 5 : 0) - 280);
  // Reduce preview down to its usable minimum before shrinking the explorer.
  const previewFloor = Math.min(260, Math.max(0, available - 170));
  const preview = showPreview
    ? Math.min(requested.preview, Math.max(previewFloor, available - requested.explorer))
    : 0;
  const explorer = Math.min(requested.explorer, Math.max(0, available - preview));
  const terminal = showTerminal ? Math.min(requested.terminal, Math.max(0, height - 160 - 5)) : 0;
  return { explorer, preview, terminal };
}
export type StructureChange = { from: string; to?: string };
export function remapPath(path: string, { from, to }: StructureChange): string | null {
  return path === from || path.startsWith(from + '/')
    ? to
      ? to + path.slice(from.length)
      : null
    : path;
}
export function runEligible(
  project: { state: string; role: string; storageExceeded: boolean } | null,
  busy: boolean,
  dialogOpen: boolean,
) {
  return (
    !!project &&
    project.state === 'running' &&
    project.role !== 'viewer' &&
    !project.storageExceeded &&
    !busy &&
    !dialogOpen
  );
}
