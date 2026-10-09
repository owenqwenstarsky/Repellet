import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	cloneSnapshot,
	detailsFor,
	formatSnapshot,
	type PlanSnapshot,
	type TodoItem,
} from "./state.ts";

const TodoInput = Type.Object({
	text: Type.String({ minLength: 1, description: "Todo item text" }),
	done: Type.Optional(Type.Boolean({ description: "Whether this item is initially complete" })),
});

const PlanParams = Type.Object({
	plan: Type.String({ minLength: 1, description: "The complete implementation-ready plan" }),
	todos: Type.Optional(Type.Array(TodoInput, { description: "Initial implementation todos" })),
});

const PlanEditParams = Type.Object({
	edits: Type.Array(Type.Object({
		oldText: Type.String({ minLength: 1 }),
		newText: Type.String(),
	}), { minItems: 1, description: "Exact replacements applied to the plan text" }),
});

function result(text: string, details: ReturnType<typeof detailsFor>, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function errorResult(action: "create" | "read" | "edit", snapshot: PlanSnapshot, error: string) {
	return result(`Error: ${error}`, detailsFor(action, snapshot, { error }), true);
}

function applyEdits(source: string, edits: Array<{ oldText: string; newText: string }>): { text?: string; error?: string; diff?: string } {
	const spans: Array<{ start: number; end: number; replacement: string }> = [];
	for (const edit of edits) {
		const start = source.indexOf(edit.oldText);
		if (start < 0) return { error: `Could not find oldText exactly: ${JSON.stringify(edit.oldText)}` };
		if (source.indexOf(edit.oldText, start + 1) >= 0) {
			return { error: `oldText must be unique in the plan: ${JSON.stringify(edit.oldText)}` };
		}
		spans.push({ start, end: start + edit.oldText.length, replacement: edit.newText });
	}
	spans.sort((a, b) => a.start - b.start);
	for (let i = 1; i < spans.length; i++) {
		if (spans[i - 1].end > spans[i].start) return { error: "Edits overlap; combine nearby edits into one replacement." };
	}
	let text = source;
	for (const span of [...spans].reverse()) text = text.slice(0, span.start) + span.replacement + text.slice(span.end);
	return { text, diff: `${source.length} → ${text.length} characters` };
}

function renderSnapshot(snapshot: PlanSnapshot, theme: any): Text {
	const todoCount = `${snapshot.todos.filter((todo) => todo.done).length}/${snapshot.todos.length} todos complete`;
	const todos = snapshot.todos.map((todo) => `${todo.done ? "✓" : "○"} #${todo.id} ${todo.text}`).join("\n");
	const text = `${theme.fg("accent", "Plan")}\n${snapshot.plan || theme.fg("dim", "(No plan)")}\n\n${theme.fg("accent", `Todos (${todoCount})`)}${todos ? `\n${todos}` : ""}`;
	return new Text(text, 0, 0);
}

export function registerPlanTools(
	pi: ExtensionAPI,
	isPlanMode: () => boolean,
	getSnapshot: () => PlanSnapshot,
	setSnapshot: (snapshot: PlanSnapshot) => void,
): void {
	pi.registerTool({
		name: "plan",
		label: "Plan",
		description: "Create the complete implementation-ready plan and its initial todo list. Call this when planning is complete for user review.",
		promptSnippet: "Create the final implementation plan and initial todos for user review.",
		promptGuidelines: ["Do not merely write the plan in assistant text; call this tool when the plan is ready.", "Include concrete files, symbols, sequencing, and verification steps in the plan."],
		parameters: PlanParams,
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		async execute(_id, params) {
			const current = getSnapshot();
			if (!isPlanMode()) return errorResult("create", current, "The plan tool is only available in plan mode.");
			const input = params as { plan: string; todos?: Array<{ text: string; done?: boolean }> };
			const text = input.plan.trim();
			if (!text) return errorResult("create", current, "The plan cannot be empty.");
			const todos: TodoItem[] = (input.todos ?? []).map((todo, index) => ({ id: index + 1, text: todo.text.trim(), done: todo.done === true })).filter((todo) => todo.text);
			const snapshot = { plan: text, todos, nextTodoId: todos.length + 1 };
			setSnapshot(snapshot);
			return { ...result(formatSnapshot(snapshot), detailsFor("create", snapshot, { review: true })), terminate: true };
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", "create plan"), 0, 0),
		renderResult: (toolResult, _opts, theme) => renderSnapshot(toolResult.details as PlanSnapshot, theme),
	});

	pi.registerTool({
		name: "plan_read",
		label: "Read plan",
		description: "Read the complete current plan and todo list before proposing or applying changes.",
		promptSnippet: "Read the current plan and todos.",
		parameters: Type.Object({}),
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		async execute() {
			if (!isPlanMode()) return errorResult("read", getSnapshot(), "plan_read is only available in plan mode.");
			const snapshot = cloneSnapshot(getSnapshot());
			return result(formatSnapshot(snapshot), detailsFor("read", snapshot));
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("plan_read")), 0, 0),
		renderResult: (toolResult, _opts, theme) => renderSnapshot(toolResult.details as PlanSnapshot, theme),
	});

	pi.registerTool({
		name: "plan_edit",
		label: "Edit plan",
		description: "Apply precise exact-text replacements to the current plan. Read the plan first and make oldText unique.",
		promptSnippet: "Make precise exact-text edits to the current plan.",
		promptGuidelines: ["Each oldText must match exactly once in the current plan.", "All matches are checked against the original plan before any replacement is applied."],
		parameters: PlanEditParams,
		exposure: "model-only",
		defaultActive: false,
		executionMode: "sequential",
		async execute(_id, params) {
			const current = getSnapshot();
			if (!isPlanMode()) return errorResult("edit", current, "plan_edit is only available in plan mode.");
			const edits = (params as { edits: Array<{ oldText: string; newText: string }> }).edits;
			const applied = applyEdits(current.plan, edits);
			if (!applied.text || applied.text === current.plan) return errorResult("edit", current, applied.error ?? "The edits made no changes.");
			const snapshot = { ...cloneSnapshot(current), plan: applied.text };
			setSnapshot(snapshot);
			return { ...result(`${formatSnapshot(snapshot)}\n\nEdit: ${applied.diff}`, detailsFor("edit", snapshot, { review: true, diff: applied.diff })), terminate: true };
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("plan_edit ")) + theme.fg("muted", "exact replacements"), 0, 0),
		renderResult: (toolResult, _opts, theme) => renderSnapshot(toolResult.details as PlanSnapshot, theme),
	});
}