import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OTHER_VALUE = "__other__";

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	prompt: string;
	options: QuestionOption[];
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	optionIndex?: number;
}

interface AskQuestionsDetails {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

const OptionSchema = Type.Object({
	value: Type.String({ description: "Stable value returned for this option" }),
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional explanation shown below the option" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique id for this question" }),
	prompt: Type.String({ description: "The question to ask" }),
	options: Type.Array(OptionSchema, {
		minItems: 2,
		description: "At least two multiple-choice options; the UI also adds a custom response option",
	}),
});

const AskQuestionsParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 3,
		description: "One to three focused questions, shown and answered sequentially",
	}),
});

function result(
	text: string,
	details: AskQuestionsDetails,
): { content: { type: "text"; text: string }[]; details: AskQuestionsDetails } {
	return { content: [{ type: "text", text }], details };
}

function normaliseQuestions(input: Question[]): Question[] {
	const usedIds = new Set<string>();
	return input.map((question, questionIndex) => {
		const baseId = question.id.trim() || `question-${questionIndex + 1}`;
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
		usedIds.add(id);

		return {
			id,
			prompt: question.prompt.trim(),
			options: question.options
				.map((option) => ({
					value: option.value.trim(),
					label: option.label.trim(),
					description: option.description?.trim() || undefined,
				}))
				.filter((option) => option.value && option.label),
		};
	});
}

/** Register the model-facing question tool. It is activated by plan mode only. */
export function registerAskQuestionsTool(pi: ExtensionAPI, isPlanMode: () => boolean): void {
	pi.registerTool({
		name: "ask_questions",
		label: "Ask questions",
		description:
			"Ask the user one to three focused multiple-choice questions while planning. Each question gets an automatic 'Type your own response' option. Questions are shown one at a time, and the user can go back to revise earlier answers.",
		promptSnippet: "Ask 1-3 focused planning questions with useful choices.",
		promptGuidelines: [
			"Use this only for genuine planning ambiguities; do not ask questions whose answers can be found by reading the repository.",
			"Ask at most three questions in one call, with at least two useful options per question.",
		],
		parameters: AskQuestionsParams,
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = normaliseQuestions(params.questions as Question[]);
			const emptyDetails: AskQuestionsDetails = { questions, answers: [], cancelled: true };

			if (!isPlanMode()) {
				return result("ask_questions is only available in plan mode.", emptyDetails);
			}
			if (ctx.mode !== "tui") {
				return result("Cannot ask questions: plan questions require Pi's interactive TUI.", emptyDetails);
			}
			if (questions.length < 1 || questions.length > 3 || questions.some((q) => !q.prompt || q.options.length < 2)) {
				return result("Invalid questions: provide one to three questions with a prompt and at least two options each.", emptyDetails);
			}

			const answers = await ctx.ui.custom<AskQuestionsDetails>((tui, theme, _keybindings, done) => {
				let current = 0;
				let optionIndex = 0;
				let editing = false;
				let reviewing = false;
				let cachedLines: string[] | undefined;
				let customError = "";
				const savedAnswers: Array<Answer | undefined> = [];

				const editorTheme: EditorTheme = {
					borderColor: (text) => theme.fg("accent", text),
					selectList: {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function refresh(): void {
					cachedLines = undefined;
					tui.requestRender();
				}

				function optionsFor(question: Question): Array<QuestionOption & { isOther?: boolean }> {
					return [...question.options, { value: OTHER_VALUE, label: "Type your own response", isOther: true }];
				}

				function setQuestion(index: number): void {
					current = Math.max(0, Math.min(questions.length - 1, index));
					reviewing = false;
					editing = false;
					customError = "";
					const answer = savedAnswers[current];
					optionIndex = answer?.wasCustom ? optionsFor(questions[current]).length - 1 : (answer?.optionIndex ?? 0);
					editor.setText("");
					refresh();
				}

				function goBack(): void {
					if (reviewing) {
						setQuestion(questions.length - 1);
					} else if (current > 0) {
						setQuestion(current - 1);
					}
				}

				function next(): void {
					if (current < questions.length - 1) {
						setQuestion(current + 1);
					} else {
						reviewing = true;
						refresh();
					}
				}

				function saveAnswer(answer: Answer): void {
					savedAnswers[current] = answer;
					customError = "";
					next();
				}

				editor.onSubmit = (value) => {
					const text = value.trim();
					if (!text) {
						customError = "Please enter a response, or press Esc to go back.";
						refresh();
						return;
					}
					saveAnswer({
						id: questions[current].id,
						value: text,
						label: text,
						wasCustom: true,
					});
					editing = false;
					editor.setText("");
				};

				function cancel(): void {
					done({
						questions,
						answers: savedAnswers.filter((answer): answer is Answer => answer !== undefined),
						cancelled: true,
					});
				}

				function handleInput(data: string): void {
					if (editing) {
						if (matchesKey(data, Key.escape)) {
							editing = false;
							customError = "";
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.escape)) {
						cancel();
						return;
					}
					if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.backspace)) {
						goBack();
						return;
					}

					if (reviewing) {
						if (matchesKey(data, Key.enter)) {
							done({
								questions,
								answers: savedAnswers.filter((answer): answer is Answer => answer !== undefined),
								cancelled: false,
							});
						}
						return;
					}

					const question = questions[current];
					const options = optionsFor(question);
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(options.length - 1, optionIndex + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const selected = options[optionIndex];
						if (selected.isOther) {
							editing = true;
							editor.setText(savedAnswers[current]?.wasCustom ? savedAnswers[current]?.value : "");
							refresh();
						} else {
							saveAnswer({
								id: question.id,
								value: selected.value,
								label: selected.label,
								wasCustom: false,
								optionIndex,
							});
						}
					}
				}

				function addWrapped(lines: string[], text: string, width: number): void {
					lines.push(...wrapTextWithAnsi(text, width));
				}

				function addPrefixed(lines: string[], prefix: string, text: string, width: number): void {
					const prefixWidth = visibleWidth(prefix);
					if (prefixWidth >= width) {
						addWrapped(lines, prefix + text, width);
						return;
					}
					const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
					const continuation = " ".repeat(prefixWidth);
					for (let i = 0; i < wrapped.length; i++) {
						lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
					}
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;
					const renderWidth = Math.max(1, width);
					const lines: string[] = [];
					const question = questions[current];

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					const progress = questions.map((_q, i) => (i < current || savedAnswers[i] ? "●" : i === current ? "◉" : "○")).join(" ");
					addPrefixed(lines, " ", theme.fg("muted", `Question ${current + 1} of ${questions.length}  ${progress}`), renderWidth);
					lines.push("");

					if (reviewing) {
						addPrefixed(lines, " ", theme.fg("accent", theme.bold("Review your answers")), renderWidth);
						lines.push("");
						for (let i = 0; i < questions.length; i++) {
							const answer = savedAnswers[i];
							if (!answer) continue;
							addPrefixed(lines, " ", theme.fg("muted", `${i + 1}. ${questions[i].prompt}`), renderWidth);
							addPrefixed(lines, "    ", theme.fg("text", answer.wasCustom ? `↳ ${answer.value}` : `↳ ${answer.label}`), renderWidth);
						}
						lines.push("");
						addPrefixed(lines, " ", theme.fg("success", "Press Enter to submit"), renderWidth);
					} else {
						addPrefixed(lines, " ", theme.fg("text", question.prompt), renderWidth);
						lines.push("");
						const options = optionsFor(question);
						for (let i = 0; i < options.length; i++) {
							const option = options[i];
							const selected = i === optionIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${option.label}${option.isOther && editing ? " ✎" : ""}`;
							addPrefixed(lines, prefix, theme.fg(selected ? "accent" : "text", label), renderWidth);
							if (option.description) {
								addPrefixed(lines, "     ", theme.fg("muted", option.description), renderWidth);
							}
						}
						if (editing) {
							lines.push("");
							addPrefixed(lines, " ", theme.fg("muted", "Your response:"), renderWidth);
							for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
							if (customError) addPrefixed(lines, " ", theme.fg("warning", customError), renderWidth);
						}
					}

					lines.push("");
					const help = editing
						? "Enter submit • Esc back"
						: reviewing
							? "← / Backspace revise • Enter submit • Esc cancel"
							: "↑↓ choose • Enter select • ← / Backspace previous • Esc cancel";
					addPrefixed(lines, " ", theme.fg("dim", help), renderWidth);
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			if (answers.cancelled) {
				return result("The user cancelled the questions.", answers);
			}
			const answerText = answers.answers
				.map((answer, index) => `${index + 1}. ${answer.id}: ${answer.wasCustom ? `user wrote “${answer.value}”` : `selected “${answer.label}”`}`)
				.join("\n");
			return result(answerText, answers);
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			return new Text(
				theme.fg("toolTitle", theme.bold("ask_questions ")) +
					theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`),
				0,
				0,
			);
		},

		renderResult(toolResult, _options, theme) {
			const details = toolResult.details as AskQuestionsDetails | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			return new Text(
				details.answers
					.map((answer) => `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${answer.wasCustom ? answer.value : answer.label}`)
					.join("\n"),
				0,
				0,
			);
		},
	});
}
