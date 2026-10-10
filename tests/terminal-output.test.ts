import { expect, it } from 'vitest';
import { terminalOutput } from '../packages/bridge/src/terminal-output.js';

const session = (buffer: string, alive = true) => ({ id: 'run', name: 'Run', alive, buffer });

it('returns no retained output after exit or removal', () => {
  expect(terminalOutput(session('private old logs', false))).toEqual({ running: false });
  expect(terminalOutput(undefined)).toEqual({ running: false });
});

it('strips terminal styling, OSC links, carriage returns, and unsafe control characters', () => {
  const output = terminalOutput(
    session('\x1b[31mred\x1b[0m\r\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07\rnext\x00\x07'),
  );
  expect(output).toMatchObject({ text: 'red\nlink\nnext', truncated: false, processId: 'run' });
});

it('keeps the newest requested lines and treats a final newline as a line terminator', () => {
  expect(terminalOutput(session('one\ntwo\nthree\n'), 2)).toMatchObject({
    text: 'two\nthree',
    truncated: true,
  });
  expect(terminalOutput(session('one\ntwo\n'), 2)).toMatchObject({
    text: 'one\ntwo',
    truncated: false,
  });
});

it('defaults to 200 lines and returns an empty running snapshot before any output', () => {
  expect(
    terminalOutput(session(Array.from({ length: 250 }, (_, i) => String(i)).join('\n'))),
  ).toMatchObject({ truncated: true });
  expect(terminalOutput(session(''))).toMatchObject({ running: true, text: '', truncated: false });
});

it.each([0, -1, 1001, 1.5, NaN])('rejects invalid tailLines %s', (tailLines) => {
  expect(() => terminalOutput(session('text'), tailLines)).toThrow('1 to 1000');
});

it('bounds UTF-8 bytes while retaining the newest output without splitting a character', () => {
  const output = terminalOutput(session('prefix' + '😀'.repeat(20000) + 'newest'));
  expect(output).toMatchObject({ truncated: true });
  if (!output.running) throw new Error('Expected running snapshot');
  expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(65536);
  expect(output.text).toMatch(/newest$/);
  expect(output.text).not.toContain('�');
});
