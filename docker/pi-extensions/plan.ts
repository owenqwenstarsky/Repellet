import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import extension from './upstream/plan/index.ts';

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
          if (answer === 'Make changes') feedback = result.answers['plan-review']?.answers[1];
          return options.includes(answer) ? answer : undefined;
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
}
