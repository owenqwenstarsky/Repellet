import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TodoItem {
	id: number;
	text: string;
	done: boolean;
}

export interface PlanSnapshot {
	plan: string;
	todos: TodoItem[];
	nextTodoId: number;
}

export type PlanToolAction = "create" | "read" | "edit" | "todo_edit";

export interface PlanToolDetails extends PlanSnapshot {
	action: PlanToolAction;
	error?: string;
	review?: boolean;
	diff?: string;
}

export function cloneSnapshot(snapshot: PlanSnapshot): PlanSnapshot {
	return {
		plan: snapshot.plan,
		todos: snapshot.todos.map((todo) => ({ ...todo })),
		nextTodoId: snapshot.nextTodoId,
	};
}

export function emptySnapshot(): PlanSnapshot {
	return { plan: "", todos: [], nextTodoId: 1 };
}

export function detailsFor(action: PlanToolAction, snapshot: PlanSnapshot, extra: Partial<PlanToolDetails> = {}): PlanToolDetails {
	return { action, ...cloneSnapshot(snapshot), ...extra };
}

/** Rebuild the latest plan state on the active session branch. */
export function reconstructPlan(ctx: ExtensionContext): PlanSnapshot {
	let snapshot = emptySnapshot();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (!["plan", "plan_read", "plan_edit", "todo_edit"].includes(message.toolName)) continue;
		const details = message.details as PlanToolDetails | undefined;
		if (!details || details.error) continue;
		snapshot = {
			plan: details.plan,
			todos: details.todos.map((todo) => ({ ...todo })),
			nextTodoId: details.nextTodoId,
		};
	}
	return snapshot;
}

export function lastPlanMutation(messages: AgentMessage[]): PlanToolDetails | undefined {
	const last = [...messages].reverse().find((message) => message.role === "toolResult");
	if (!last || !["plan", "plan_edit"].includes(last.toolName)) return undefined;
	const details = last.details as PlanToolDetails | undefined;
	return details && !details.error && details.review ? details : undefined;
}

export function formatSnapshot(snapshot: PlanSnapshot): string {
	const plan = snapshot.plan || "(No plan has been created.)";
	const todos = snapshot.todos.length
		? snapshot.todos.map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`).join("\n")
		: "(No todos.)";
	return `Plan:\n${plan}\n\nTodos:\n${todos}`;
}
