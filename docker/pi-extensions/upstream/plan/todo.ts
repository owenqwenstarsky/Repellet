import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cloneSnapshot, detailsFor, formatSnapshot, type PlanSnapshot } from "./state.ts";

const Operation = Type.Object({
	action: Type.Union([
		Type.Literal("add"), Type.Literal("update"), Type.Literal("complete"), Type.Literal("remove"), Type.Literal("move"),
	]),
	id: Type.Optional(Type.Number({ description: "Existing todo ID" })),
	text: Type.Optional(Type.String({ description: "New or added todo text" })),
	done: Type.Optional(Type.Boolean({ description: "Completion state for update/complete" })),
	beforeId: Type.Optional(Type.Number({ description: "Insert this item before this ID; omit to move to the end" })),
});

const TodoEditParams = Type.Object({
	operations: Type.Array(Operation, { minItems: 1, description: "One or more todo patches, applied in order" }),
});

interface TodoOperation { action: "add" | "update" | "complete" | "remove" | "move"; id?: number; text?: string; done?: boolean; beforeId?: number }

function output(snapshot: PlanSnapshot, error?: string) {
	return {
		content: [{ type: "text" as const, text: error ? `Error: ${error}` : formatSnapshot(snapshot) }],
		details: detailsFor("todo_edit", snapshot, error ? { error } : {}),
		...(error ? { isError: true } : {}),
	};
}

export function registerTodoTool(pi: ExtensionAPI, getSnapshot: () => PlanSnapshot, setSnapshot: (snapshot: PlanSnapshot) => void): void {
	pi.registerTool({
		name: "todo_edit",
		label: "Edit todos",
		description: "Patch the current plan's todo list. Available outside plan mode to mark work complete. Supports add, update, complete, remove, and move by stable ID.",
		promptSnippet: "Update individual plan todos by stable ID.",
		promptGuidelines: ["Use stable todo IDs returned by plan, plan_read, or todo_edit.", "Prefer complete to mark work done; do not remove completed work unless requested."],
		parameters: TodoEditParams,
		executionMode: "sequential",
		async execute(_id, params) {
			const current = cloneSnapshot(getSnapshot());
			const original = cloneSnapshot(current);
			if (!current.plan) return output(original, "No plan exists yet. Create a plan before editing its todos.");
			const operations = (params as { operations: TodoOperation[] }).operations;
			for (const operation of operations) {
				if (operation.action === "add") {
					const text = operation.text?.trim();
					if (!text) return output(current, "add requires non-empty text.");
					const item = { id: current.nextTodoId++, text, done: operation.done === true };
					if (operation.beforeId === undefined) current.todos.push(item);
					else {
						const index = current.todos.findIndex((todo) => todo.id === operation.beforeId);
						if (index < 0) return output(current, `Todo #${operation.beforeId} not found.`);
						current.todos.splice(index, 0, item);
					}
					continue;
				}
				if (operation.id === undefined) return output(current, `${operation.action} requires id.`);
				const index = current.todos.findIndex((todo) => todo.id === operation.id);
				if (index < 0) return output(current, `Todo #${operation.id} not found.`);
				const todo = current.todos[index];
				switch (operation.action) {
					case "update":
						if (!operation.text?.trim()) return output(current, "update requires non-empty text.");
						todo.text = operation.text.trim();
						if (operation.done !== undefined) todo.done = operation.done;
						break;
					case "complete":
						todo.done = operation.done ?? true;
						break;
					case "remove":
						current.todos.splice(index, 1);
						break;
					case "move": {
						const [moved] = current.todos.splice(index, 1);
						if (operation.beforeId === undefined) current.todos.push(moved);
						else {
							const target = current.todos.findIndex((item) => item.id === operation.beforeId);
							if (target < 0) return output(current, `Todo #${operation.beforeId} not found.`);
							current.todos.splice(target, 0, moved);
						}
						break;
					}
				}
			}
			setSnapshot(current);
			return output(current);
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("todo_edit ")) + theme.fg("muted", "update todos"), 0, 0),
		renderResult: (toolResult, _opts, theme) => {
			const details = toolResult.details as PlanSnapshot & { error?: string };
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${details?.todos?.filter((todo) => todo.done).length ?? 0}/${details?.todos?.length ?? 0} todos complete`), 0, 0);
		},
	});
}