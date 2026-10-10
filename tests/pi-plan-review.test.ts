import { expect, it, vi } from 'vitest';
import plan from '../docker/pi-extensions/plan.ts';

// Exercise the real extension with an in-memory session and UI event channel.
// No model provider, filesystem session, or external service is started.
async function fixture(initialBranch: any[] = []) {
  let branch = structuredClone(initialBranch);
  let activeTools = ['read', 'bash', 'edit', 'write', 'question', 'todo_edit'];
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const dialogs: any[] = [];
  const prompts: any[] = [];
  const ctx = { sessionManager: { getBranch: () => branch }, hasUI: false };

  async function emit(name: string, event: any = {}) {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const next = await handler(event, ctx);
      if (next) {
        result = { ...result, ...next };
        if (next.systemPrompt !== undefined) event.systemPrompt = next.systemPrompt;
      }
    }
    return result;
  }
  async function systemPrompt() {
    return (await emit('before_agent_start', { systemPrompt: 'Base instructions.' }))?.systemPrompt;
  }

  plan({
    events: { emit: (_name: string, request: any) => dialogs.push(request) },
    on: (name: string, handler: any) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...new Set([...activeTools, ...tools.keys()])].map((name) => ({ name })),
    setActiveTools: (names: string[]) => (activeTools = [...names]),
    appendEntry: (customType: string, data: any) => {
      branch.push({ type: 'custom', customType, data: structuredClone(data) });
    },
    sendUserMessage: vi.fn(async (text: string, options: any) => {
      prompts.push({ text, options, systemPrompt: await systemPrompt(), tools: [...activeTools] });
    }),
  } as any);
  await emit('session_start');

  async function command(args = '') {
    await commands.get('plan').handler(args, ctx);
  }
  async function review(toolName = 'plan', params: any = { plan: 'Update app.ts.' }) {
    const result = await tools.get(toolName).execute('plan-call', params);
    const message = { role: 'toolResult', toolName, ...result };
    branch.push({ type: 'message', message });
    return emit('agent_end', { messages: [message] });
  }
  return {
    dialogs,
    prompts,
    command,
    review,
    systemPrompt,
    branch: () => branch,
    activeTools: () => activeTools,
    switchBranch: async (entries: any[]) => {
      branch = structuredClone(entries);
      await emit('session_tree');
    },
  };
}

it('records UI approval before the implementation prompt and supplies it to the model', async () => {
  const f = await fixture();
  await f.command();
  const turn = f.review();
  await vi.waitFor(() => expect(f.dialogs).toHaveLength(1));
  expect(f.prompts).toHaveLength(0);
  expect(f.activeTools()).not.toContain('write');
  expect(await f.systemPrompt()).toContain('PLAN MODE ACTIVE');

  f.dialogs[0].resolve({ answers: { 'plan-review': { answers: ['Implement the plan'] } } });
  await turn;

  expect(f.branch().slice(-2)).toEqual([
    {
      type: 'custom',
      customType: 'repellet.plan-review',
      data: { choice: 'Implement the plan' },
    },
    { type: 'custom', customType: 'plan-mode-state', data: { enabled: false } },
  ]);
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]).toMatchObject({
    text: expect.stringContaining('Implement the plan above'),
    options: { deliverAs: 'followUp' },
    systemPrompt: expect.stringContaining('explicitly selected "Implement the plan"'),
    tools: expect.arrayContaining(['write', 'edit', 'question']),
  });
  expect(f.prompts[0].systemPrompt).toContain('Base instructions.');
  expect(f.prompts[0].systemPrompt).toContain('Do not ask again whether to implement');
  expect(f.prompts[0].systemPrompt).not.toContain('PLAN MODE ACTIVE');
  expect(f.dialogs).toHaveLength(1);

  // Approval survives session reloads and forks of the approved branch.
  const restored = await fixture(f.branch());
  expect(await restored.systemPrompt()).toContain('explicitly selected "Implement the plan"');
  expect(restored.activeTools()).toContain('write');

  // Navigating to an earlier branch cannot carry approval across from this one.
  await f.switchBranch(f.branch().slice(0, -2));
  expect(await f.systemPrompt()).toContain('PLAN MODE ACTIVE');
  expect(await f.systemPrompt()).not.toContain('explicitly selected "Implement the plan"');
  expect(f.activeTools()).not.toContain('write');
});

it('keeps revision feedback in plan mode without authorizing implementation', async () => {
  const f = await fixture();
  await f.command();
  const turn = f.review();
  await vi.waitFor(() => expect(f.dialogs).toHaveLength(1));
  f.dialogs[0].resolve({
    answers: { 'plan-review': { answers: ['Make changes', 'Include rollback checks'] } },
  });
  await turn;

  expect(f.dialogs).toHaveLength(1);
  expect(f.prompts[0]).toMatchObject({
    text: expect.stringContaining('Include rollback checks'),
    options: { deliverAs: 'steer' },
  });
  expect(f.prompts[0].systemPrompt).toContain('PLAN MODE ACTIVE');
  expect(f.prompts[0].systemPrompt).not.toContain('explicitly selected "Implement the plan"');
  expect(f.activeTools()).not.toContain('write');
  await f.command('off');
  expect(await f.systemPrompt()).toBeUndefined();
});

it.each([{ answers: [] }, { answers: ['Custom scope'] }])(
  'does not treat an invalid review answer %j as approval',
  async ({ answers }) => {
    const f = await fixture();
    await f.command();
    const turn = f.review();
    await vi.waitFor(() => expect(f.dialogs).toHaveLength(1));
    f.dialogs[0].resolve({ answers: { 'plan-review': { answers } } });
    await turn;

    expect(f.prompts).toHaveLength(0);
    expect(f.branch().some((entry) => entry.customType === 'repellet.plan-review')).toBe(false);
    expect(f.activeTools()).not.toContain('write');
  },
);

it('clears prior approval when starting a new planning phase, including a manual exit', async () => {
  const f = await fixture();
  await f.command();
  const turn = f.review();
  await vi.waitFor(() => expect(f.dialogs).toHaveLength(1));
  f.dialogs[0].resolve({ answers: { 'plan-review': { answers: ['Implement the plan'] } } });
  await turn;
  expect(await f.systemPrompt()).toContain('explicitly selected "Implement the plan"');

  await f.command();
  expect(await f.systemPrompt()).toContain('PLAN MODE ACTIVE');
  expect(await f.systemPrompt()).not.toContain('explicitly selected "Implement the plan"');
  await f.command('off');
  expect(await f.systemPrompt()).toBeUndefined();
});

it.each(['plan', 'plan_edit'])(
  'does not reuse approval for a later %s result',
  async (toolName) => {
    const f = await fixture([
      {
        type: 'custom',
        customType: 'repellet.plan-review',
        data: { choice: 'Implement the plan' },
      },
      { type: 'custom', customType: 'plan-mode-state', data: { enabled: false } },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName,
          details: { plan: 'A revised plan.', todos: [], nextTodoId: 1 },
        },
      },
    ]);
    expect(await f.systemPrompt()).toBeUndefined();
  },
);

it('does not infer implementation approval from manually disabling plan mode', async () => {
  const f = await fixture();
  await f.command();
  await f.command('off');
  expect(f.activeTools()).toContain('write');
  expect(await f.systemPrompt()).toBeUndefined();
  expect(f.prompts).toHaveLength(0);
});
