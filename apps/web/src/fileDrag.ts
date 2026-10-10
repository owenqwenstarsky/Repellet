export const workspaceDragType = 'application/x-repellet-workspace-entry';
export type WorkspaceDrag = { projectId: string; path: string; kind: string };
export type UploadItem = { path: string; file?: File };
export const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');
export const joinPath = (directory: string, path: string) =>
  [directory, path].filter(Boolean).join('/');
export function readWorkspaceDrag(data: DataTransfer): WorkspaceDrag | null {
  try {
    const value = JSON.parse(data.getData(workspaceDragType));
    return typeof value.projectId === 'string' &&
      typeof value.path === 'string' &&
      value.path &&
      ['file', 'directory', 'symlink'].includes(value.kind)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function canMove(source: WorkspaceDrag, projectId: string, target: string) {
  return (
    source.projectId === projectId &&
    parentPath(source.path) !== target &&
    target !== source.path &&
    !target.startsWith(source.path + '/')
  );
}
// Capture entry handles synchronously: browsers clear the drag data after the drop handler.
export function droppedItems(data: DataTransfer): Promise<UploadItem[]> {
  const items = Array.from(data.items || []).filter((item) => item.kind === 'file');
  const entries = items.map((item) => item.webkitGetAsEntry?.());
  const files = Array.from(data.files || []);
  const itemFiles = items.map((item) => item.getAsFile?.() || null);
  if (!entries.some(Boolean)) {
    if (items.some((_, index) => !itemFiles[index])) {
      return Promise.reject(
        new Error('This browser cannot read dropped folders. Use Upload folder instead.'),
      );
    }
    return Promise.resolve(files.map((file) => ({ path: file.name, file })));
  }
  async function visit(entry: FileSystemEntry, prefix = ''): Promise<UploadItem[]> {
    const path = joinPath(prefix, entry.name);
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      return [{ path, file }];
    }
    if (!entry.isDirectory) throw new Error('Cannot read this drop. Use Upload folder instead.');
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const result: UploadItem[] = [{ path }];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!batch.length) break;
      for (const child of batch) result.push(...(await visit(child, path)));
    }
    return result;
  }
  return (async () => {
    const result: UploadItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (entries[i]) result.push(...(await visit(entries[i]!)));
      else {
        const file = itemFiles[i];
        if (!file) throw new Error('Cannot read this drop. Use Upload folder instead.');
        result.push({ path: file.name, file });
      }
    }
    return result;
  })();
}
