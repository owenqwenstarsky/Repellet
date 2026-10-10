import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import extension from './upstream/plan/index.ts';

const REVIEW_ENTRY = 'repellet.plan-review';

function implementationApproved(ctx: ExtensionContext): boolean {
  let approved = false;
  let enabled = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === 'custom' && entry.customType === 'plan-mode-state') {
      enabled = (entry.data as { enabled?: boolean } | undefined)?.enabled === true;
      if (enabled) approved = false;
    } else if (entry.type === 'custom' && entry.customType === REVIEW_ENTRY) {
      approved = (entry.data as { choice?: string } | undefined)?.choice === 'Implement the plan';
    } else if (
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      ['plan', 'plan_edit'].includes(entry.message.toolName) &&
      !entry.message.isError
    ) {
      approved = false;
    }
  }
  return approved && !enabled;
}

/** Use Repellet questions for the extension's terminal dialogs. No TUI is emulated. */
export default function plan(pi: ExtensionAPI) {
  function ask(questions: any[], signal?: AbortSignal, itemId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      pi.events.emit('repellet:question', { questions, signal, itemId, resolve, reject });
    });
  }
  function context(ctx: any) {
    let feedback: string | undefined;
    return {
      ...ctx,
      hasUI: true,
      ui: {
        // Pi's terminal theme is uninitialized in the SDK host.
        theme: { fg: (_color: string, text: string) => text },
        setStatus: () => {},
        notify: () => {},
        async select(title: string, options: string[]) {
          feedback = undefined;
          const result = await ask([
            {
              id: 'plan-review',
              header: 'Plan review',
              question: title,
              isOther: false,
              options: options.map((label) => ({
                label,
                description: '',
                ...(label === 'Make changes'
                  ? { textInput: { placeholder: 'What should change in the plan?' } }
                  : {}),
              })),
            },
          ]);
          const answer = result.answers['plan-review']?.answers[0];
          if (!options.includes(answer)) return undefined;
          // UI answers are not model messages. Persist the decision before the
          // upstream extension disables plan mode and queues implementation.
          pi.appendEntry(REVIEW_ENTRY, { choice: answer });
          if (answer === 'Make changes') feedback = result.answers['plan-review']?.answers[1];
          return answer;
        },
        async editor(title: string) {
          // Plan review feedback is collected in the same browser form as the
          // action choice. Never open a second form for a malformed/empty reply.
          return feedback ?? '';
        },
      },
    };
  }
  extension({
    ...pi,
    on(event: any, handler: any) {
      pi.on(event, (value: any, ctx: any) => handler(value, context(ctx)));
    },
    registerCommand(name: string, command: any) {
      pi.registerCommand(name, {
        ...command,
        handler: (args: string, ctx: any) => command.handler(args, context(ctx)),
      });
    },
    registerTool(tool: any) {
      if (tool.name !== 'ask_questions') return pi.registerTool(tool);
      pi.registerTool({
        ...tool,
        description:
          'Ask the owner one to three focused planning questions with useful choices or a custom response.',
        async execute(id: string, params: any, signal: AbortSignal, _update: any, ctx: any) {
          let enabled = false;
          for (const entry of ctx.sessionManager.getBranch())
            if (entry.type === 'custom' && entry.customType === 'plan-mode-state')
              enabled = entry.data?.enabled === true;
          if (!enabled)
            return {
              content: [
                { type: 'text' as const, text: 'ask_questions is only available in plan mode.' },
              ],
              isError: true,
            };
          const used = new Set<string>();
          const questions = params.questions.map((question: any, index: number) => {
            const base = question.id.trim() || `question-${index + 1}`;
            let id = base,
              suffix = 2;
            while (used.has(id)) id = `${base}-${suffix++}`;
            used.add(id);
            return { ...question, id };
          });
          const response = await ask(
            questions.map((question: any) => ({
              id: question.id,
              header: 'Planning question',
              question: question.prompt,
              options: question.options.map((option: any) => ({
                label: option.label,
                description: option.description || '',
              })),
            })),
            signal,
            id,
          );
          const answers = questions.map((question: any) => {
            const label = response.answers[question.id]?.answers[0] || '';
            const selected = question.options.find((option: any) => option.label === label);
            return {
              id: question.id,
              value: selected?.value || label,
              label,
              wasCustom: !selected,
            };
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(answers) }],
            details: { questions, answers, cancelled: false },
          };
        },
      });
    },
  } as ExtensionAPI);

  pi.on('before_agent_start', async (event, ctx) => {
    if (!implementationApproved(ctx)) return;
    return {
      systemPrompt: `${event.systemPrompt}

The user reviewed the current plan and explicitly selected "Implement the plan" in the plan review UI. That selection authorizes implementation of this plan. Plan mode is now off; the previous read-only planning restrictions applied to the planning phase. Proceed with the approved changes and verification. Do not ask again whether to implement the plan or claim that no execution choice was recorded. Ask a question only if new missing information or a separate required approval blocks the work.`,
    };
  });
}
