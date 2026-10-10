// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileTree } from '../../apps/web/src/Files';
import { UiProvider } from '../../apps/web/src/ui';
import { api, post } from '../../apps/web/src/api';
import { canMove, droppedItems, workspaceDragType } from '../../apps/web/src/fileDrag';
import { deferred } from './helpers';
vi.mock('../../apps/web/src/api', () => ({
  api: vi.fn(),
  post: vi.fn(),
  errorMessage: (e: Error) => e.message,
}));
const root = [
  { name: 'src', path: 'src', kind: 'directory' },
  { name: 'other', path: 'other', kind: 'directory' },
  { name: 'a.txt', path: 'a.txt', kind: 'file' },
];
const props = { projectId: 'project', active: '', onOpen: vi.fn(), editable: true, revision: 0 };
beforeEach(() => {
  vi.mocked(post).mockReset().mockResolvedValue({});
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (url) => {
      if (url.endsWith('path=')) return root;
      if (url.endsWith('path=src')) return [{ name: 'b.txt', path: 'src/b.txt', kind: 'file' }];
      return [];
    });
});
async function tree(overrides = {}) {
  const view = render(
    <UiProvider>
      <FileTree {...props} {...overrides} />
    </UiProvider>,
  );
  await screen.findByRole('button', { name: 'a.txt' });
  return view;
}
const row = (name: string) => screen.getByRole('button', { name, exact: true });
function file(name = 'local.txt', size?: number) {
  const result = new File(['hello'], name, { type: 'text/plain' });
  Object.defineProperty(result, 'arrayBuffer', {
    value: vi.fn(async () => new TextEncoder().encode('hello').buffer),
  });
  if (size !== undefined) Object.defineProperty(result, 'size', { value: size });
  return result;
}
function transfer(files: File[] = []) {
  const data = new Map<string, string>();
  return {
    types: files.length ? ['Files'] : [],
    files,
    items: [],
    dropEffect: 'none',
    effectAllowed: 'all',
    getData: (type: string) => data.get(type) || '',
    setData(type: string, value: string) {
      data.set(type, value);
      this.types.push(type);
    },
  };
}
function internal(path: string, kind = 'file', projectId = 'project') {
  const data = transfer();
  data.setData(workspaceDragType, JSON.stringify({ projectId, path, kind }));
  return data;
}
function entry(name: string, children?: unknown[]) {
  if (children) {
    let batch = 0;
    return {
      name,
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (resolve: (entries: unknown[]) => void) =>
          resolve(batch++ === 0 ? children : []),
      }),
    };
  }
  return {
    name,
    isDirectory: false,
    isFile: true,
    file: (resolve: (file: File) => void) => resolve(file(name)),
  };
}
function folderTransfer() {
  const data = transfer();
  data.types = ['Files'];
  return {
    ...data,
    items: [
      {
        kind: 'file',
        webkitGetAsEntry: () =>
          entry('folder', [entry('nested', [entry('x.txt')]), entry('empty', [])]),
      },
    ],
  };
}
it('uploads on root, folder and file-parent targets without bubbling', async () => {
  await tree();
  fireEvent.drop(row('Workspace root'), { dataTransfer: transfer([file()]) });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/upload', {
      path: 'local.txt',
      data: 'aGVsbG8=',
    }),
  );
  await screen.findByText('Upload complete: 1 items completed, 0 failed or skipped.');
  fireEvent.drop(row('src'), { dataTransfer: transfer([file('second.txt')]) });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/upload', {
      path: 'src/second.txt',
      data: 'aGVsbG8=',
    }),
  );
  await waitFor(() => expect(row('New file').hasAttribute('disabled')).toBe(false));
  fireEvent.click(row('src'));
  await screen.findByRole('button', { name: 'b.txt' });
  fireEvent.drop(row('b.txt'), { dataTransfer: transfer([file('third.txt')]) });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/upload', {
      path: 'src/third.txt',
      data: 'aGVsbG8=',
    }),
  );
  expect(post).toHaveBeenCalledTimes(3);
});
it('uploads tree background to root and preserves folder structure and empty directories', async () => {
  const { container } = await tree();
  fireEvent.drop(container.querySelector('.file-tree')!, { dataTransfer: folderTransfer() });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(4));
  expect(post).toHaveBeenCalledWith('/projects/project/files/create', {
    path: 'folder/empty',
    kind: 'directory',
  });
  expect(post).toHaveBeenCalledWith('/projects/project/files/upload', {
    path: 'folder/nested/x.txt',
    data: 'aGVsbG8=',
  });
});
it('reads all directory batches and offers a picker fallback for unreadable folders', async () => {
  const readEntries = vi
    .fn()
    .mockImplementationOnce((resolve) => resolve([entry('a.txt')]))
    .mockImplementationOnce((resolve) => resolve([entry('b.txt')]))
    .mockImplementation((resolve) => resolve([]));
  const data = {
    ...transfer(),
    types: ['Files'],
    items: [
      {
        kind: 'file',
        webkitGetAsEntry: () => ({
          name: 'folder',
          isDirectory: true,
          createReader: () => ({ readEntries }),
        }),
      },
    ],
  };
  expect((await droppedItems(data as unknown as DataTransfer)).map((item) => item.path)).toEqual([
    'folder',
    'folder/a.txt',
    'folder/b.txt',
  ]);
  await tree();
  fireEvent.drop(row('src'), {
    dataTransfer: {
      ...transfer(),
      types: ['Files'],
      items: [{ kind: 'file', getAsFile: () => null }],
    },
  });
  await screen.findByText(/Use Upload folder instead/);
  expect(post).not.toHaveBeenCalled();
});
it('continues after oversized files and collisions and reports each failure', async () => {
  vi.mocked(post)
    .mockRejectedValueOnce(new Error('Destination already exists'))
    .mockResolvedValue({});
  await tree();
  fireEvent.drop(row('src'), {
    dataTransfer: transfer([
      file('large.txt', 8 * 1024 * 1024 + 1),
      file('exists.txt'),
      file('ok.txt'),
    ]),
  });
  await screen.findByText('Upload complete: 1 items completed, 2 failed or skipped.');
  expect(screen.getByText('large.txt: uploads are limited to 8 MiB.')).toBeTruthy();
  expect(screen.getByText('exists.txt: Destination already exists')).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(2);
});
it('shares picker uploads and disables mutations while uploading', async () => {
  const pending = deferred();
  vi.mocked(post).mockReturnValue(pending.promise);
  const { container } = await tree();
  fireEvent.click(row('src'));
  await screen.findByRole('button', { name: 'b.txt' });
  const upload = container.querySelector('input[type=file]')!;
  fireEvent.change(upload, { target: { files: [file()] } });
  await screen.findByText('Uploading 1 of 1…');
  expect(row('New file').hasAttribute('disabled')).toBe(true);
  expect(row('a.txt').getAttribute('draggable')).toBe('false');
  fireEvent.drop(row('other'), { dataTransfer: transfer([file()]) });
  expect(post).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({}));
  expect(post).toHaveBeenCalledWith('/projects/project/files/upload', {
    path: 'src/local.txt',
    data: 'aGVsbG8=',
  });
});
it('moves files into folders and out to root, refreshing both parents', async () => {
  await tree();
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  expect(screen.getByRole('status').textContent).toBe('Move to src');
  fireEvent.drop(row('src'), { dataTransfer: data });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/move', {
      from: 'a.txt',
      to: 'src/a.txt',
    }),
  );
  await waitFor(() => expect(row('New file').hasAttribute('disabled')).toBe(false));
  fireEvent.drop(row('Workspace root'), { dataTransfer: internal('src/b.txt') });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/move', {
      from: 'src/b.txt',
      to: 'b.txt',
    }),
  );
  expect(api).toHaveBeenCalledWith('/projects/project/files?path=src', expect.anything());
});
it('rejects invalid destinations, cross-project moves, and unrelated drops', async () => {
  await tree();
  for (const [path, kind, target, project] of [
    ['a.txt', 'file', 'Workspace root', 'project'],
    ['src', 'directory', 'src', 'project'],
    ['a.txt', 'file', 'src', 'elsewhere'],
  ])
    fireEvent.drop(row(target), { dataTransfer: internal(path, kind, project) });
  const data = transfer();
  data.setData('text/plain', 'https://example.com');
  fireEvent.drop(row('src'), { dataTransfer: data });
  expect(post).not.toHaveBeenCalled();
  expect(
    canMove({ projectId: 'project', path: 'src', kind: 'directory' }, 'project', 'src/nested'),
  ).toBe(false);
});
it('moves folders and reports conflicts without retries or overwrites', async () => {
  vi.mocked(post).mockRejectedValue(new Error('Destination already exists'));
  await tree();
  fireEvent.drop(row('other'), { dataTransfer: internal('src', 'directory') });
  await screen.findByText('Destination already exists');
  expect(post).toHaveBeenCalledExactlyOnceWith('/projects/project/files/move', {
    from: 'src',
    to: 'other/src',
  });
});
it('disables drag and drop for viewers', async () => {
  await tree({ editable: false });
  expect(row('a.txt').getAttribute('draggable')).toBe('false');
  fireEvent.drop(row('src'), { dataTransfer: transfer([file()]) });
  fireEvent.drop(row('src'), { dataTransfer: internal('a.txt') });
  expect(post).not.toHaveBeenCalled();
});
it('expands hovered folders after 600 ms and clears feedback on cancellation', async () => {
  await tree();
  vi.useFakeTimers();
  const data = transfer([file()]);
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  expect(screen.getByRole('status').textContent).toBe('Upload to src');
  await act(async () => vi.advanceTimersByTime(599));
  expect(row('src').getAttribute('aria-expanded')).toBe('false');
  await act(async () => vi.advanceTimersByTime(1));
  expect(row('src').getAttribute('aria-expanded')).toBe('true');
  fireEvent.dragOver(row('other'), { dataTransfer: data });
  fireEvent.keyDown(window, { key: 'Escape' });
  await act(async () => vi.advanceTimersByTime(600));
  expect(row('other').getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('status')).toBeNull();
});
it('cleans pending hover on project change and unmount', async () => {
  const view = await tree();
  vi.useFakeTimers();
  fireEvent.dragOver(row('src'), { dataTransfer: transfer([file()]) });
  view.rerender(
    <UiProvider>
      <FileTree {...props} projectId="next" />
    </UiProvider>,
  );
  await act(async () => vi.advanceTimersByTime(600));
  expect(screen.queryByRole('status')).toBeNull();
  expect(row('src').getAttribute('aria-expanded')).toBe('false');
  fireEvent.dragOver(row('src'), { dataTransfer: transfer([file()]) });
  view.unmount();
  const calls = vi.mocked(api).mock.calls.length;
  await act(async () => vi.advanceTimersByTime(600));
  expect(api).toHaveBeenCalledTimes(calls);
});
it('retains folder picker paths and accepts empty local files', async () => {
  const { container } = await tree();
  const local = file('empty.txt', 0);
  Object.defineProperty(local, 'webkitRelativePath', { value: 'picked/nested/empty.txt' });
  fireEvent.change(container.querySelectorAll('input[type=file]')[1], {
    target: { files: [local] },
  });
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/upload', {
      path: 'picked/nested/empty.txt',
      data: 'aGVsbG8=',
    }),
  );
});
it('retains keyboard-accessible Rename / move', async () => {
  await tree();
  fireEvent.keyDown(row('a.txt'), { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByText('Rename / move'));
  const input = screen.getByRole('textbox', { name: 'Workspace path' });
  fireEvent.change(input, { target: { value: 'other/renamed.txt' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith('/projects/project/files/move', {
      from: 'a.txt',
      to: 'other/renamed.txt',
    }),
  );
});
it('remaps expanded and selected directories after a structure event', async () => {
  const view = await tree();
  fireEvent.click(row('src'));
  await screen.findByRole('button', { name: 'b.txt' });
  vi.mocked(api).mockImplementation(async (url) =>
    url.endsWith('path=')
      ? [{ name: 'renamed', path: 'renamed', kind: 'directory' }]
      : [{ name: 'b.txt', path: 'renamed/b.txt', kind: 'file' }],
  );
  view.rerender(
    <UiProvider>
      <FileTree {...props} revision={1} structure={{ from: 'src', to: 'renamed' }} />
    </UiProvider>,
  );
  await screen.findByRole('button', { name: 'renamed' });
  expect(row('renamed').getAttribute('aria-expanded')).toBe('true');
  expect(row('renamed').classList.contains('selected')).toBe(true);
  expect((await screen.findByRole('button', { name: 'b.txt' })).getAttribute('title')).toBe(
    'renamed/b.txt',
  );
});
it('merges into existing directories while preserving file collisions', async () => {
  vi.mocked(post).mockImplementation(async (url, body) => {
    const path = (body as { path: string }).path;
    if (url.endsWith('/create') && path === 'folder') throw new Error('Already exists');
    if (url.endsWith('/upload')) throw new Error('Destination already exists');
    return {};
  });
  await tree();
  fireEvent.drop(row('Workspace root'), { dataTransfer: folderTransfer() });
  await screen.findByText('Upload complete: 3 items completed, 1 failed or skipped.');
  expect(screen.getByText('folder/nested/x.txt: Destination already exists')).toBeTruthy();
});
it('rejects invalid hover targets and cancels hover after drop or dragend', async () => {
  await tree();
  vi.useFakeTimers();
  const data = transfer();
  fireEvent.dragStart(row('src'), { dataTransfer: data });
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  expect(data.dropEffect).toBe('none');
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.dragOver(row('other'), { dataTransfer: data });
  fireEvent.dragEnd(row('src'), { dataTransfer: data });
  await act(async () => vi.advanceTimersByTime(600));
  expect(row('other').getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('status')).toBeNull();
});
it('stops subsequent uploads after changing projects', async () => {
  const pending = deferred();
  vi.mocked(post).mockReturnValue(pending.promise);
  const view = await tree();
  fireEvent.drop(row('src'), { dataTransfer: transfer([file('first.txt'), file('second.txt')]) });
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  view.rerender(
    <UiProvider>
      <FileTree {...props} projectId="next" />
    </UiProvider>,
  );
  await act(async () => pending.resolve({}));
  expect(post).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/Upload complete/)).toBeNull();
});
