import { describe, it, expect } from 'vitest';
import {
  safeRelativePath,
  runtimesSchema,
  environmentSchema,
  projectCreateSchema,
} from '@repellet/shared';
describe('workspace input boundaries', () => {
  it('normalizes relative paths and rejects traversal on both host platforms', () => {
    expect(safeRelativePath('./src//main.ts')).toBe('src/main.ts');
    for (const path of [
      '../secret',
      'src/../../secret',
      '/etc/passwd',
      'C:/secret',
      'src\\..\\secret',
      'a\0b',
    ])
      expect(() => safeRelativePath(path)).toThrow();
  });
  it('allows runtime combinations but not repeated or unknown runtimes', () => {
    expect(runtimesSchema.parse(['python', 'node'])).toEqual(['python', 'node']);
    for (const value of [[], ['node', 'node'], ['bash']])
      expect(() => runtimesSchema.parse(value)).toThrow();
  });
  it('protects workspace service variables and validates names', () => {
    expect(environmentSchema.parse({ API_KEY: 'abc' })).toEqual({ API_KEY: 'abc' });
    for (const name of ['BRIDGE_TOKEN', 'NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'BAD-NAME'])
      expect(() => environmentSchema.parse({ [name]: 'x' })).toThrow();
  });
  it('rejects clone URLs that could be interpreted as command options', () => {
    expect(() =>
      projectCreateSchema.parse({
        name: 'test',
        runtimes: ['node'],
        cloneUrl: '--upload-pack=bad',
      }),
    ).toThrow();
  });
});

it('requires revision feedback and rejects undeclared review choices before resolving', async () => {
  const { validQuestionAnswers } = await import('@repellet/shared');
  const questions = [
    {
      id: 'review',
      header: 'Plan review',
      question: 'Plan complete',
      isOther: false,
      options: [
        { label: 'Implement the plan', description: '' },
        {
          label: 'Make changes',
          description: '',
          textInput: { placeholder: 'What should change?' },
        },
      ],
    },
  ];
  const answer = (...answers: string[]) => ({ review: { answers } });
  expect(validQuestionAnswers(questions, answer('Implement the plan'))).toBe(true);
  expect(validQuestionAnswers(questions, answer('Make changes', 'Add tests'))).toBe(true);
  for (const answers of [
    answer(''),
    answer('Keep planning'),
    answer('Make changes'),
    answer('Make changes', '  '),
    {},
  ])
    expect(validQuestionAnswers(questions, answers)).toBe(false);
  expect(
    validQuestionAnswers(questions, {
      ...answer('Implement the plan'),
      extra: { answers: ['Unexpected'] },
    }),
  ).toBe(false);
  expect(validQuestionAnswers([{ ...questions[0]!, isOther: true }], answer('Custom'))).toBe(true);
});
