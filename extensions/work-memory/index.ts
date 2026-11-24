/**
 * work-memory: a short, cross-project log of what you worked on and what is unfinished.
 *
 * Data lives in ~/.work-memory/ (WORK_MEMORY_DIR overrides) as plain JSONL so other
 * harnesses can read it. See README.md.
 */
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { formatTodo, searchTodos } from "./logseq.ts";
import { loadConfig, runWriter, summarize, type CompleteResult, type RunReport } from "./runner.ts";
import { applyOps, formatItem, loadItems, memoryRoot, prune, renderIndex, saveItems, searchItems, today, type ItemOp } from "./store.ts";

const SECTION = "work_memory";
const STATUS_KEY = "work-memory";

const Params = Type.Object({
	action: StringEnum(["search", "update", "logseq_todos"] as const, {
		description: "search: find work items. update: change or create an item. logseq_todos: find open tasks in the user's Logseq notes.",
	}),
	query: Type.Optional(Type.String({ description: "search/logseq_todos: words that must all match" })),
	cwd: Type.Optional(Type.String({ description: "search: limit to items from this repo path or name" })),
	includeDone: Type.Optional(Type.Boolean({ description: "search: include finished items (default false)" })),
	limit: Type.Optional(Type.Number({ description: "max results (default 15 for search, 20 for logseq_todos)" })),
	id: Type.Optional(Type.String({ description: "update: existing item id; omit to create a new item" })),
	title: Type.Optional(Type.String({ description: "update: short title (required when creating)" })),
	status: Type.Optional(Type.String({ description: "update: free-text status, what is left or what it waits on" })),
	done: Type.Optional(Type.Boolean({ description: "update: mark finished (true) or reopen (false)" })),
	links: Type.Optional(Type.Array(Type.String(), { description: "update: Jira keys, PR URLs, branches to add" })),
	keepDays: Type.Optional(
		Type.Number({ description: "update: keep the item at least this many days from today (default pruning is 60 days after last update); -1 keeps it forever, 0 removes the keep" }),
	),
	page: Type.Optional(Type.String({ description: "logseq_todos: page name or journal date substring, e.g. 'gls' or '2026_11'" })),
	tag: Type.Optional(Type.String({ description: "logseq_todos: tag or page reference inside the task, without # or [[ ]]" })),
	markers: Type.Optional(Type.Array(Type.String(), { description: "logseq_todos: task markers (default TODO, DOING, LATER, NOW)" })),
});
type Input = Static<typeof Params>;

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: undefined };
}

function keepUntilFor(days: number, now: number): string | null {
	if (days < 0) return "forever";
	if (days === 0) return null;
	return today(now + days * 86_400_000);
}

async function completeWith(ctx: ExtensionContext, modelKey: string, system: string, prompt: string, signal: AbortSignal): Promise<CompleteResult> {
	const slash = modelKey.indexOf("/");
	const model = ctx.modelRegistry.find(modelKey.slice(0, slash), modelKey.slice(slash + 1));
	if (!model) throw new Error(`model ${modelKey} not found`);
	const res = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
		{ maxTokens: 2000, signal, cacheRetention: "none" },
	);
	if (res.stopReason === "error" || res.stopReason === "aborted") throw new Error(res.errorMessage ?? `model call ${res.stopReason}`);
	const out = res.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	return { text: out, cost: res.usage?.cost?.total ?? 0 };
}

export default function workMemory(pi: ExtensionAPI) {
	const root = memoryRoot();
	let indexSnapshot = "";
	let abort: AbortController | undefined;
	let running: Promise<RunReport | undefined> | undefined;

	function startWriter(ctx: ExtensionContext, announceIdle: boolean): Promise<RunReport | undefined> {
		if (running) return running;
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionDir = ctx.sessionManager.getSessionDir();
		if (!sessionDir) return Promise.resolve(undefined);
		abort = new AbortController();
		const signal = abort.signal;
		const config = loadConfig(root);
		running = runWriter({
			root,
			sessionsRoot: path.dirname(sessionDir),
			exclude: new Set(sessionFile ? [sessionFile] : []),
			config,
			now: Date.now,
			signal,
			complete: (model, system, prompt, s) => completeWith(ctx, model, system, prompt, s),
			onProgress: (done, total) => {
				if (ctx.hasUI && total > 1) ctx.ui.setStatus(STATUS_KEY, `work-memory ${done}/${total}`);
			},
		})
			.then((report) => {
				const msg = summarize(report) ?? (announceIdle ? (report.status === "locked" ? "work-memory: another pi window is updating" : "work-memory: nothing new") : undefined);
				if (msg && ctx.hasUI && !signal.aborted) ctx.ui.notify(msg, report.failed ? "warning" : "info");
				return report;
			})
			.catch((e: unknown) => {
				if (ctx.hasUI && !signal.aborted) ctx.ui.notify(`work-memory failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				return undefined;
			})
			.finally(() => {
				if (ctx.hasUI && !signal.aborted) ctx.ui.setStatus(STATUS_KEY, "");
				running = undefined;
			});
		return running;
	}

	pi.on("session_start", async (_event, ctx) => {
		const now = Date.now();
		indexSnapshot = renderIndex(prune(loadItems(root), now), ctx.cwd, now);
		// Subagent children (sub) and one-shot runs should not spend tokens on bookkeeping.
		if (process.env.PI_SUB_RUN_DIR || !ctx.hasUI) return;
		void startWriter(ctx, false);
	});

	pi.on("session_shutdown", async () => {
		abort?.abort();
	});

	// The snapshot is fixed per session so the section never changes mid-session and the prompt cache holds.
	pi.on("before_agent_start", (event) => {
		if (indexSnapshot) event.systemPromptOptions.sections[SECTION] = indexSnapshot;
		else delete event.systemPromptOptions.sections[SECTION];
	});

	pi.registerTool({
		name: "work_memory",
		label: "Work memory",
		description:
			"The user's cross-project log of work items (title, free-text status, open/done, links) built from earlier sessions, plus their open Logseq tasks. " +
			"search: find items, including older or done ones. update: change status, mark done, keep longer, or create an item. logseq_todos: open TODO/DOING/LATER/NOW tasks from Logseq notes, filtered.",
		promptSnippet: "Search or update the user's cross-session work log, or look up their open Logseq TODOs.",
		promptGuidelines: [
			"Use work_memory search when the user asks what they worked on, what is unfinished, or about earlier work not shown in the work_memory section.",
			"Use work_memory update when the user says to remember, finish, drop, or keep a work item; keepDays=-1 keeps it forever.",
			"Use work_memory logseq_todos with a query, page, or tag filter; avoid listing everything.",
		],
		parameters: Params,
		async execute(_id, params: Input, _signal, _onUpdate, ctx) {
			const now = Date.now();
			if (params.action === "search") {
				const items = prune(loadItems(root), now);
				const hits = searchItems(items, { query: params.query, cwd: params.cwd, includeDone: params.includeDone, limit: params.limit });
				if (!hits.length) return text("No matching work items.");
				return text(hits.map((i) => formatItem(i, now)).join("\n"));
			}
			if (params.action === "update") {
				const items = loadItems(root);
				if (params.id && !items.some((i) => i.id === params.id)) return { ...text(`No item with id "${params.id}".`), isError: true };
				if (!params.id && !params.title) return { ...text("update needs an id, or a title to create an item."), isError: true };
				const op: ItemOp = { id: params.id, title: params.title, status: params.status, done: params.done, links: params.links };
				if (typeof params.keepDays === "number") op.keepUntil = keepUntilFor(params.keepDays, now);
				const res = applyOps(items, [op], now, { cwd: params.id ? undefined : ctx.cwd });
				saveItems(root, res.items);
				const id = res.added[0] ?? res.updated[0];
				const item = res.items.find((i) => i.id === id);
				return text(item ? `${res.added.length ? "Created" : "Updated"}:\n${formatItem(item, now)}` : "Nothing changed.");
			}
			const config = loadConfig(root);
			try {
				const { todos, total } = searchTodos(config.logseqDir, {
					query: params.query,
					page: params.page,
					tag: params.tag,
					markers: params.markers,
					limit: params.limit,
				});
				if (!todos.length) return text("No matching Logseq tasks.");
				const more = total > todos.length ? `\n(${total - todos.length} more; narrow with query/page/tag)` : "";
				return text(todos.map(formatTodo).join("\n") + more);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return { ...text(`Cannot read Logseq graph at ${config.logseqDir}: ${msg}`), isError: true };
			}
		},
	});

	pi.registerCommand("work-memory", {
		description: "work-memory: show the index, or `run` to process finished sessions now",
		handler: async (args, ctx) => {
			if (args.trim() === "run") {
				ctx.ui.notify("work-memory: processing finished sessions…", "info");
				await startWriter(ctx, true);
				return;
			}
			const now = Date.now();
			const index = renderIndex(prune(loadItems(root), now), ctx.cwd, now);
			ctx.ui.notify(index || "work-memory: no items yet", "info");
		},
	});
}
