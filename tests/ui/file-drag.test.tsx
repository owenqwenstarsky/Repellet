// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Profiler } from 'react';
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
const pointDescriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
afterEach(() => {
  if (pointDescriptor) Object.defineProperty(document, 'elementFromPoint', pointDescriptor);
  else Reflect.deleteProperty(document, 'elementFromPoint');
});
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
// jsdom has no DragEvent constructor, so its generic drag events omit mouse coordinates.
function dragAt(
  type: 'dragover' | 'drop',
  target: Element,
  data: ReturnType<typeof transfer>,
  y: number,
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y });
  Object.defineProperty(event, 'dataTransfer', { value: data });
  fireEvent(target, event);
}
function hitTest(element: Element | null) {
  const hit = vi.fn(() => element);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  return hit;
}
function scrolling(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>('.file-tree')!;
  Object.defineProperties(element, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 1000 },
  });
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 200,
    top: 0,
    bottom: 100,
    width: 200,
    height: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const request = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    element,
    frames,
    request,
    cancel,
    frame(time: number) {
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(time));
      });
    },
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
it('expands hovered folders after 1500 ms and clears feedback on cancellation', async () => {
  await tree();
  vi.useFakeTimers();
  const data = transfer([file()]);
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  expect(screen.getByRole('status').textContent).toBe('Upload to src');
  await act(async () => vi.advanceTimersByTime(1499));
  expect(row('src').getAttribute('aria-expanded')).toBe('false');
  await act(async () => vi.advanceTimersByTime(1));
  expect(row('src').getAttribute('aria-expanded')).toBe('true');
  fireEvent.dragOver(row('other'), { dataTransfer: data });
  fireEvent.keyDown(window, { key: 'Escape' });
  await act(async () => vi.advanceTimersByTime(1500));
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
  await act(async () => vi.advanceTimersByTime(1500));
  expect(screen.queryByRole('status')).toBeNull();
  expect(row('src').getAttribute('aria-expanded')).toBe('false');
  fireEvent.dragOver(row('src'), { dataTransfer: transfer([file()]) });
  view.unmount();
  const calls = vi.mocked(api).mock.calls.length;
  await act(async () => vi.advanceTimersByTime(1500));
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
  await act(async () => vi.advanceTimersByTime(1500));
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
it('keeps a permanent feedback footer outside the tree without inserting rows', async () => {
  const { container } = await tree();
  const element = container.querySelector('.file-tree')!;
  const footer = container.querySelector('.file-drop-status')!;
  const rows = [...element.querySelectorAll('.file-row')];
  expect(footer.parentElement).toBe(element.parentElement);
  expect(element.contains(footer)).toBe(false);
  expect(footer.textContent).toBe('');
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  expect(screen.getByRole('status')).toBe(footer);
  expect(footer.getAttribute('title')).toBe('Move to src');
  expect([...element.querySelectorAll('.file-row')]).toEqual(rows);
  fireEvent.dragEnd(row('a.txt'), { dataTransfer: data });
  expect(container.querySelector('.file-drop-status')).toBe(footer);
  expect(footer.textContent).toBe('');
});
it('does not commit React updates for repeated drag events on the same destination', async () => {
  const commits = vi.fn();
  render(
    <UiProvider>
      <Profiler id="tree" onRender={commits}>
        <FileTree {...props} />
      </Profiler>
    </UiProvider>,
  );
  await screen.findByRole('button', { name: 'a.txt' });
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  commits.mockClear();
  for (let i = 0; i < 20; i++)
    fireEvent.dragOver(row('src').querySelector(i % 2 ? 'span' : 'svg')!, { dataTransfer: data });
  expect(commits).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toBe('Move to src');
});
it('preserves hover when crossing icons and labels, including null related targets', async () => {
  await tree();
  vi.useFakeTimers();
  const data = transfer();
  const folder = row('src');
  const icon = folder.querySelector('svg')!;
  const label = folder.querySelector('span')!;
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragEnter(folder, { dataTransfer: data });
  fireEvent.dragOver(icon, { dataTransfer: data });
  await act(async () => vi.advanceTimersByTime(750));
  fireEvent.dragEnter(label, { dataTransfer: data });
  fireEvent.dragLeave(icon, { dataTransfer: data, relatedTarget: label });
  hitTest(label);
  fireEvent.dragLeave(label, { dataTransfer: data, relatedTarget: null });
  fireEvent.dragOver(label, { dataTransfer: data });
  expect(folder.classList.contains('drop-target')).toBe(true);
  await act(async () => vi.advanceTimersByTime(750));
  expect(folder.getAttribute('aria-expanded')).toBe('true');
  for (let i = 0; i < 5; i++) fireEvent.dragOver(folder, { dataTransfer: data });
  await act(async () => vi.advanceTimersByTime(3000));
  expect(vi.mocked(api).mock.calls.filter(([url]) => url.endsWith('path=src'))).toHaveLength(1);
});
it('cancels hover on a true exit and preserves the source for re-entry', async () => {
  const { container } = await tree();
  vi.useFakeTimers();
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragEnter(row('src'), { dataTransfer: data });
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  await act(async () => vi.advanceTimersByTime(750));
  hitTest(null);
  fireEvent.dragLeave(row('src'), { dataTransfer: data });
  await act(async () => vi.advanceTimersByTime(1500));
  expect(row('src').getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.dragEnter(row('other'), { dataTransfer: data });
  fireEvent.dragOver(row('other'), { dataTransfer: data });
  expect(screen.getByRole('status').textContent).toBe('Move to other');
  // An outside dragover also handles exits whose dragleave was missed by the browser.
  fireEvent.dragOver(container, { dataTransfer: data });
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => vi.advanceTimersByTime(1500));
  expect(row('other').getAttribute('aria-expanded')).toBe('false');
});
it('highlights the actual parent when hovering file rows', async () => {
  await tree();
  fireEvent.click(row('src'));
  await screen.findByRole('button', { name: 'b.txt' });
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragOver(row('b.txt'), { dataTransfer: data });
  expect(row('src').classList.contains('drop-target')).toBe(true);
  expect(row('b.txt').classList.contains('drop-target')).toBe(false);
  fireEvent.drop(row('b.txt'), { dataTransfer: data });
  await waitFor(() =>
    expect(post).toHaveBeenCalledExactlyOnceWith('/projects/project/files/move', {
      from: 'a.txt',
      to: 'src/a.txt',
    }),
  );
  await waitFor(() => expect(row('New file').hasAttribute('disabled')).toBe(false));
  const back = transfer();
  fireEvent.dragStart(row('b.txt'), { dataTransfer: back });
  fireEvent.dragOver(row('a.txt'), { dataTransfer: back });
  expect(row('Workspace root').classList.contains('drop-target')).toBe(true);
  expect(row('a.txt').classList.contains('drop-target')).toBe(false);
});
it('scrolls at a frame-based speed and drops into the destination beneath the pointer', async () => {
  const { container } = await tree();
  const scroll = scrolling(container);
  const hit = hitTest(row('src'));
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  dragAt('dragover', row('src'), data, 84);
  expect(scroll.frames.size).toBe(1);
  scroll.frame(100);
  expect(scroll.element.scrollTop).toBe(0);
  scroll.frame(116);
  expect(scroll.element.scrollTop).toBeCloseTo(3.84);
  hit.mockReturnValue(row('other').querySelector('span')!);
  scroll.frame(132);
  expect(scroll.element.scrollTop).toBeCloseTo(7.68);
  expect(screen.getByRole('status').textContent).toBe('Move to other');
  expect(row('other').classList.contains('drop-target')).toBe(true);
  // A delayed frame is capped to avoid large jumps after the tab was suspended.
  scroll.frame(1000);
  expect(scroll.element.scrollTop).toBeCloseTo(15.36);
  // No browser drag data is needed between native drag events.
  data.types = [];
  scroll.frame(1016);
  expect(screen.getByRole('status').textContent).toBe('Move to other');
  data.types = [workspaceDragType];
  dragAt('drop', row('src'), data, 84);
  expect(scroll.frames.size).toBe(0);
  await waitFor(() =>
    expect(post).toHaveBeenCalledExactlyOnceWith('/projects/project/files/move', {
      from: 'a.txt',
      to: 'other/a.txt',
    }),
  );
});
it('scrolls upward, stops in the middle, and respects scroll boundaries', async () => {
  const { container } = await tree();
  const scroll = scrolling(container);
  hitTest(row('other'));
  const data = transfer();
  scroll.element.scrollTop = 100;
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  dragAt('dragover', row('other'), data, 16);
  scroll.frame(0);
  scroll.frame(16);
  expect(scroll.element.scrollTop).toBeCloseTo(96.16);
  dragAt('dragover', row('other'), data, 50);
  expect(scroll.frames.size).toBe(0);
  scroll.element.scrollTop = 1;
  dragAt('dragover', row('other'), data, 0);
  scroll.frame(32);
  scroll.frame(48);
  expect(scroll.element.scrollTop).toBe(0);
  scroll.frame(64);
  expect(scroll.frames.size).toBe(0);
  scroll.element.scrollTop = 899;
  dragAt('dragover', row('other'), data, 99);
  scroll.frame(80);
  scroll.frame(96);
  expect(scroll.element.scrollTop).toBe(900);
  scroll.frame(112);
  expect(scroll.frames.size).toBe(0);
});
it.each(['Escape', 'blur', 'dragend', 'outside', 'outside drop'])(
  'stops scrolling and pending folder expansion on %s',
  async (reason) => {
    const { container } = await tree();
    vi.useFakeTimers();
    const scroll = scrolling(container);
    hitTest(row('other'));
    const data = transfer();
    fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
    dragAt('dragover', row('other'), data, 84);
    expect(scroll.frames.size).toBe(1);
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (reason === 'blur') fireEvent.blur(window);
    else if (reason === 'dragend') fireEvent.dragEnd(row('a.txt'), { dataTransfer: data });
    else if (reason === 'outside drop') {
      const consumed = document.createElement('div');
      document.body.append(consumed);
      consumed.addEventListener('drop', (event) => event.stopPropagation());
      fireEvent.drop(consumed, { dataTransfer: data });
      consumed.remove();
    } else fireEvent.dragOver(document.body, { dataTransfer: data });
    expect(scroll.frames.size).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1500));
    expect(row('other').getAttribute('aria-expanded')).toBe('false');
    if (reason === 'Escape' || reason === 'blur') {
      fireEvent.dragOver(row('other'), { dataTransfer: data });
      fireEvent.drop(row('other'), { dataTransfer: data });
      expect(screen.queryByRole('status')).toBeNull();
      expect(post).not.toHaveBeenCalled();
    }
  },
);
it.each([{ visible: false }, { editable: false }, { projectId: 'next' }])(
  'cancels active drag work when props change to %j',
  async (overrides) => {
    const view = await tree();
    vi.useFakeTimers();
    const scroll = scrolling(view.container);
    hitTest(row('other'));
    const data = transfer();
    fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
    dragAt('dragover', row('other'), data, 84);
    expect(scroll.frames.size).toBe(1);
    view.rerender(
      <UiProvider>
        <FileTree {...props} {...overrides} />
      </UiProvider>,
    );
    expect(scroll.frames.size).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1500));
    expect(row('other').getAttribute('aria-expanded')).toBe('false');
    fireEvent.drop(row('other'), { dataTransfer: data });
    expect(post).not.toHaveBeenCalled();
  },
);
it('cancels scrolling and hover on unmount', async () => {
  const view = await tree();
  vi.useFakeTimers();
  const scroll = scrolling(view.container);
  hitTest(row('other'));
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  dragAt('dragover', row('other'), data, 84);
  expect(scroll.frames.size).toBe(1);
  view.unmount();
  expect(scroll.frames.size).toBe(0);
  const calls = vi.mocked(api).mock.calls.length;
  await act(async () => vi.advanceTimersByTime(1500));
  expect(api).toHaveBeenCalledTimes(calls);
});
it.each([{ from: 'a.txt' }, { from: 'a.txt', to: 'renamed.txt' }])(
  'cancels a drag when a structure event changes its source: %j',
  async (structure) => {
    const view = await tree();
    vi.useFakeTimers();
    const scroll = scrolling(view.container);
    hitTest(row('other'));
    const data = transfer();
    fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
    dragAt('dragover', row('other'), data, 84);
    expect(scroll.frames.size).toBe(1);
    view.rerender(
      <UiProvider>
        <FileTree {...props} revision={1} structure={[structure]} />
      </UiProvider>,
    );
    expect(scroll.frames.size).toBe(0);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1500));
    expect(row('other').getAttribute('aria-expanded')).toBe('false');
    fireEvent.drop(row('other'), { dataTransfer: data });
    expect(post).not.toHaveBeenCalled();
  },
);
it('cancels when a refreshed listing no longer contains the source', async () => {
  const view = await tree();
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragOver(row('other'), { dataTransfer: data });
  vi.mocked(api).mockResolvedValue(root.filter((entry) => entry.path !== 'a.txt'));
  view.rerender(
    <UiProvider>
      <FileTree {...props} revision={1} />
    </UiProvider>,
  );
  await waitFor(() => expect(screen.queryByRole('button', { name: 'a.txt' })).toBeNull());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  fireEvent.drop(row('other'), { dataTransfer: data });
  expect(post).not.toHaveBeenCalled();
});
it('cancels pending expansion when switching to an invalid destination', async () => {
  await tree();
  vi.useFakeTimers();
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.dragOver(row('src'), { dataTransfer: data });
  await act(async () => vi.advanceTimersByTime(750));
  fireEvent.dragOver(row('Workspace root'), { dataTransfer: data });
  expect(data.dropEffect).toBe('none');
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => vi.advanceTimersByTime(1500));
  expect(row('src').getAttribute('aria-expanded')).toBe('false');
  fireEvent.drop(row('Workspace root'), { dataTransfer: data });
  expect(post).not.toHaveBeenCalled();
});
it('sends only one move while a drop is pending and prevents new drags', async () => {
  const pending = deferred();
  vi.mocked(post).mockReturnValue(pending.promise);
  await tree();
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  fireEvent.drop(row('src'), { dataTransfer: data });
  fireEvent.drop(row('other'), { dataTransfer: data });
  expect(post).toHaveBeenCalledExactlyOnceWith('/projects/project/files/move', {
    from: 'a.txt',
    to: 'src/a.txt',
  });
  expect(fireEvent.dragStart(row('a.txt'), { dataTransfer: transfer() })).toBe(false);
  await act(async () => pending.resolve({}));
});
it('stops drag work when a picker upload makes the tree busy', async () => {
  const pending = deferred();
  vi.mocked(post).mockReturnValue(pending.promise);
  const view = await tree();
  vi.useFakeTimers();
  const scroll = scrolling(view.container);
  hitTest(row('other'));
  const data = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: data });
  dragAt('dragover', row('other'), data, 84);
  expect(scroll.frames.size).toBe(1);
  fireEvent.change(view.container.querySelector('input[type=file]')!, {
    target: { files: [file()] },
  });
  expect(scroll.frames.size).toBe(0);
  await act(async () => vi.advanceTimersByTime(1500));
  expect(row('other').getAttribute('aria-expanded')).toBe('false');
  fireEvent.drop(row('other'), { dataTransfer: data });
  expect(post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(post).mock.calls[0][0]).toContain('/upload');
  await act(async () => pending.resolve({}));
});
it('allows a fresh internal drag and local upload after cancelling a session', async () => {
  await tree();
  const first = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: first });
  fireEvent.dragOver(row('src'), { dataTransfer: first });
  fireEvent.keyDown(window, { key: 'Escape' });
  const next = transfer();
  fireEvent.dragStart(row('a.txt'), { dataTransfer: next });
  fireEvent.dragOver(row('other'), { dataTransfer: next });
  expect(screen.getByRole('status').textContent).toBe('Move to other');
  fireEvent.keyDown(window, { key: 'Escape' });
  const local = transfer([file()]);
  fireEvent.dragEnter(row('src'), { dataTransfer: local });
  fireEvent.dragOver(row('src'), { dataTransfer: local });
  expect(screen.getByRole('status').textContent).toBe('Upload to src');
  fireEvent.drop(row('src'), { dataTransfer: local });
  await waitFor(() =>
    expect(post).toHaveBeenCalledExactlyOnceWith('/projects/project/files/upload', {
      path: 'src/local.txt',
      data: 'aGVsbG8=',
    }),
  );
});
