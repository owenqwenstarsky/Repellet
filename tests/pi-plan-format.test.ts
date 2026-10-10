import { expect, it } from 'vitest';
import { formatSnapshot } from '../docker/pi-extensions/upstream/plan/state';

it.each(['', 'Plan:\n', 'Plan:\r\n', '  Plan: \n'])(
  'formats a plan with prefix %j using one label and preserves its body and todos',
  (prefix) => {
    const body = '1. **Create** — Add `main.go`.\n2. **Serve** — Serve the directory.';
    const snapshot = {
      plan: prefix + body,
      todos: [
        { id: 1, text: 'Create executable', done: false },
        { id: 2, text: 'Serve files', done: true },
      ],
      nextTodoId: 3,
    };
    const before = structuredClone(snapshot);
    expect(formatSnapshot(snapshot)).toBe(
      `${prefix || 'Plan:\n'}${body}\n\nTodos:\n[ ] #1: Create executable\n[x] #2: Serve files`,
    );
    expect(snapshot).toEqual(before);
  },
);

it('preserves inline plan text and empty-plan placeholders', () => {
  expect(formatSnapshot({ plan: 'Plan: describe the change.', todos: [], nextTodoId: 1 })).toBe(
    'Plan:\nPlan: describe the change.\n\nTodos:\n(No todos.)',
  );
  expect(formatSnapshot({ plan: '', todos: [], nextTodoId: 1 })).toBe(
    'Plan:\n(No plan has been created.)\n\nTodos:\n(No todos.)',
  );
});
