// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes } from 'mdast';
import type { ThreadItem } from '@repellet/agent-protocol';
import { AgentItem } from '../apps/web/src/AgentItems';
import { remarkFileReferences } from '../apps/web/src/remarkFileReferences';

function message(text: string): ThreadItem {
  return {
    type: 'agentMessage',
    id: 'message',
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
}

function parse(text: string) {
  return unified().use(remarkParse).use(remarkGfm).use(remarkFileReferences).parse(text);
}

function references(node: Nodes): string[] {
  const path = node.data?.hProperties?.['data-file-reference'];
  return [
    ...(typeof path === 'string' ? [path] : []),
    ...('children' in node ? node.children.flatMap(references) : []),
  ];
}

it('parses file references as safe nodes while retaining Markdown around standalone tags', () => {
  const tree = parse('<file path="README.md" />\n**Next**\n\n- <file path="src/app.ts" />');
  expect(references(tree)).toEqual(['README.md', 'src/app.ts']);
  expect(tree.children.map((node) => node.type)).toEqual(['paragraph', 'list']);
  expect(JSON.stringify(tree)).toContain('strong');
  expect(JSON.stringify(tree)).not.toContain('repellet-file-reference');
});

it('opens normalized file paths from inline, list, table, and standalone references', () => {
  const openFile = vi.fn();
  const text = [
    'Start with <file path="/workspace/src/data/portfolio.ts" /> and <file path="README.md" />.',
    '',
    '<file path="./docs/My Report.md" />',
    '',
    "- Edit <file path='src/app.ts' />",
    '',
    '| File | Status |',
    '| --- | --- |',
    '| <file path="src/table.ts" /> | ~~old~~ |',
  ].join('\n');
  const view = render(<AgentItem item={message(text)} onOpenFile={openFile} />);
  for (const path of [
    'src/data/portfolio.ts',
    'README.md',
    'docs/My Report.md',
    'src/app.ts',
    'src/table.ts',
  ]) {
    const button = screen.getByRole('button', { name: path, exact: true });
    expect(button.getAttribute('title')).toBe(`Open file ${path}`);
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(openFile).toHaveBeenLastCalledWith(path);
  }
  expect(view.container.querySelector('p')?.textContent).toBe(
    'Start with src/data/portfolio.ts and README.md.',
  );
  expect(view.container.querySelector('li button')).not.toBeNull();
  expect(view.container.querySelector('td button')).not.toBeNull();
  expect(view.container.querySelector('del')?.textContent).toBe('old');
});

it('supports keyboard activation', async () => {
  const openFile = vi.fn();
  const user = userEvent.setup();
  render(<AgentItem item={message('<file path="README.md" />')} onOpenFile={openFile} />);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'README.md' }));
  await user.keyboard('{Enter}');
  await user.keyboard(' ');
  expect(openFile.mock.calls).toEqual([['README.md'], ['README.md']]);
});

it('keeps code and escaped syntax examples literal, including incomplete examples', () => {
  const text = [
    '`<file path="inline.ts" />`',
    '',
    '```xml',
    '<file path="fenced.ts" />',
    '```',
    '',
    '    <file path="indented.ts" />',
    '',
    '\\<file path="escaped.ts" />',
    '',
    '`<file path="` then <file path="actual.ts" />',
  ].join('\n');
  const view = render(<AgentItem item={message(text)} onOpenFile={vi.fn()} />);
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['actual.ts']);
  for (const path of ['inline.ts', 'fenced.ts', 'indented.ts', 'escaped.ts']) {
    expect(view.container.textContent).toContain(`<file path="${path}" />`);
  }
  expect(references(parse(text))).toEqual(['actual.ts']);
});

it.each([
  '<file path="" />',
  '<file path="../secret" />',
  '<file path="/workspace/../secret" />',
  '<file path="https://example.com/a" />',
  '<file path="javascript:alert(1)" />',
  '<file path="//host/a" />',
  '<file path="/home/agent/secret" />',
  '<file path="C:\\secret" />',
  '<file path="src\\app.ts" />',
  '<file path="README.md" line="2" />',
  '<file path=README.md />',
  '<file path="README.md">label</file>',
  '<file />',
])('leaves invalid or unsupported references literal: %s', (tag) => {
  const view = render(<AgentItem item={message(`Before ${tag} after`)} onOpenFile={vi.fn()} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(view.container.textContent).toBe(`Before ${tag} after`);
  expect(references(parse(tag))).toEqual([]);
});

it('activates streamed references only when their self-closing tag is complete', () => {
  const view = render(
    <AgentItem item={message('Edit <file path="src/app.ts"')} onOpenFile={vi.fn()} />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(view.container.textContent).toBe('Edit <file path="src/app.ts"');
  view.rerender(
    <AgentItem item={message('Edit <file path="src/app.ts" /')} onOpenFile={vi.fn()} />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(view.container.textContent).toBe('Edit <file path="src/app.ts" /');
  view.rerender(
    <AgentItem item={message('Edit <file path="src/app.ts" />')} onOpenFile={vi.fn()} />,
  );
  expect(screen.getByRole('button', { name: 'src/app.ts' })).toBeTruthy();
});

it('keeps arbitrary HTML and unsafe links blocked and prevents placeholder impersonation', () => {
  const view = render(
    <AgentItem
      item={message(
        [
          '<script><file path="script.ts" /></script>',
          '',
          '<div><file path="html.ts" /></div>',
          '',
          '<img src="x" onerror="alert(1)">',
          '',
          '[bad](javascript:alert(1)) [fake](repellet-file-reference)',
          '',
          '[<file path="nested.ts" />](https://example.com)',
          '',
          '<file path="safe.ts" /> and [web](https://example.com)',
        ].join('\n'),
      )}
      onOpenFile={vi.fn()}
    />,
  );
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['safe.ts']);
  expect(view.container.querySelector('script, img, [onerror]')).toBeNull();
  expect(Array.from(view.container.querySelectorAll('a')).map((link) => link.href)).toEqual([
    'https://example.com/',
    'https://example.com/',
  ]);
});

it('enables plan references without changing user messages, reasoning, or plan tool output', () => {
  const openFile = vi.fn();
  const tag = '<file path="README.md" />';
  const view = render(
    <AgentItem
      item={{ type: 'plan', id: 'plan', text: `[ ] Edit ${tag}` }}
      onOpenFile={openFile}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'README.md' }));
  expect(openFile).toHaveBeenCalledWith('README.md');
  view.rerender(
    <AgentItem item={{ type: 'plan', id: 'plan', summary: `Edit ${tag}` }} onOpenFile={openFile} />,
  );
  expect(screen.getByRole('button', { name: 'README.md' })).toBeTruthy();
  view.rerender(
    <AgentItem
      item={{ type: 'userMessage', id: 'user', content: [{ type: 'text', text: tag }] }}
      onOpenFile={openFile}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(view.container.textContent).toBe(tag);
  view.rerender(
    <AgentItem
      item={{ type: 'reasoning', id: 'reasoning', summary: [tag], content: [] }}
      onOpenFile={openFile}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(
    <AgentItem
      item={{
        type: 'dynamicToolCall',
        id: 'tool',
        namespace: null,
        tool: 'plan_read',
        arguments: {},
        status: 'completed',
        success: true,
        durationMs: null,
        contentItems: [{ type: 'inputText', text: tag }],
      }}
      onOpenFile={openFile}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
});
