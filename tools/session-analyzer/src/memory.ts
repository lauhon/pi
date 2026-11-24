/**
 * The work-memory extension's log (`extensions/work-memory`) as outcome evidence: which work
 * item a session belongs to, how that item ended, and what each item cost. Read-only; the
 * extension owns `items.jsonl`. The parse rules copy `store.ts` so the tool does not load an
 * extension module; a test keeps the two in agreement.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionSummary } from "./observables.ts";

export interface MemoryItem {
	id: string;
	title: string;
	status: string;
	done: boolean;
	cwd?: string;
	/** Jira keys, PR URLs, branches, and absolute session file paths (ending in .jsonl). */
	links: string[];
	created: string;
	updated: string;
	keepUntil?: string;
}

/** `--memory`, else `$WORK_MEMORY_DIR/items.jsonl`, else `~/.work-memory/items.jsonl`, as the extension resolves it. */
export function memoryPath(option?: string, env: NodeJS.ProcessEnv = process.env): string {
	if (option) return expandHome(option);
	return join(env.WORK_MEMORY_DIR || join(homedir(), ".work-memory"), "items.jsonl");
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function isItem(value: unknown): value is MemoryItem {
	if (!value || typeof value !== "object") return false;
	const o = value as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		typeof o.title === "string" &&
		typeof o.status === "string" &&
		typeof o.done === "boolean" &&
		Array.isArray(o.links) &&
		typeof o.created === "string" &&
		typeof o.updated === "string"
	);
}

/** One item per line; a broken line or a line missing a required field is skipped, as the extension does. */
export function parseMemory(text: string): MemoryItem[] {
	const items: MemoryItem[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isItem(value)) items.push(value);
		} catch {
			// a hand-edit typo; the rest stays usable
		}
	}
	return items;
}

/** A missing file means no memory, not an error. */
export function loadMemory(path: string): MemoryItem[] {
	if (!existsSync(path)) return [];
	return parseMemory(readFileSync(path, "utf8"));
}

export function sessionLinks(item: MemoryItem): string[] {
	return [...new Set(item.links.filter((link) => typeof link === "string" && link.endsWith(".jsonl")).map((link) => resolve(expandHome(link))))];
}

/** Session path (resolved) to the items that link it. */
export type MemoryIndex = Map<string, MemoryItem[]>;

export function indexMemory(items: MemoryItem[]): MemoryIndex {
	const index: MemoryIndex = new Map();
	for (const item of items) {
		for (const session of sessionLinks(item)) {
			const list = index.get(session) ?? [];
			list.push(item);
			index.set(session, list);
		}
	}
	return index;
}

export interface SessionMemory {
	id: string;
	title: string;
	status: string;
	done: boolean;
	/** Sessions of the same item other than this one. */
	otherSessions: number;
}

export function memoryForSession(index: MemoryIndex, sessionPath: string): SessionMemory[] {
	const path = resolve(sessionPath);
	return (index.get(path) ?? []).map((item) => ({
		id: item.id,
		title: item.title,
		status: item.status,
		done: item.done,
		otherSessions: sessionLinks(item).filter((link) => link !== path).length,
	}));
}

export interface WorkItemRow {
	/** Undefined for the trailing row of sessions no item links. */
	id?: string;
	title: string;
	done?: boolean;
	status?: string;
	/** Sessions the item links that were loaded (inside the dirs and the window). */
	sessions: number;
	/** Sessions the item links in all. */
	linkedSessions: number;
	turns: number;
	requests: number;
	cost: number;
	firstSession?: string;
	lastSession?: string;
}

/**
 * One row per item with the totals of its loaded sessions, by cost; a session linked by two
 * items counts in both. The last row sums the sessions no item links.
 */
export function workItemRows(items: MemoryItem[], summaries: SessionSummary[]): WorkItemRow[] {
	const byPath = new Map(summaries.map((summary) => [resolve(summary.path), summary]));
	const linked = new Set<string>();
	const rows = items.map((item) => {
		const links = sessionLinks(item);
		for (const link of links) linked.add(link);
		const sessions = links.map((link) => byPath.get(link)).filter((summary): summary is SessionSummary => summary !== undefined);
		return { id: item.id, title: item.title, done: item.done, status: item.status, linkedSessions: links.length, ...totals(sessions) };
	});
	rows.sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id));
	const unlinked = summaries.filter((summary) => !linked.has(resolve(summary.path)));
	return [...rows, { title: "(sessions no work item links)", linkedSessions: 0, ...totals(unlinked) }];
}

function totals(sessions: SessionSummary[]): Pick<WorkItemRow, "sessions" | "turns" | "requests" | "cost" | "firstSession" | "lastSession"> {
	const starts = sessions.map((summary) => summary.startedAt).sort();
	return {
		sessions: sessions.length,
		turns: sessions.reduce((sum, summary) => sum + summary.turns, 0),
		requests: sessions.reduce((sum, summary) => sum + summary.requests, 0),
		cost: sessions.reduce((sum, summary) => sum + summary.cost, 0),
		...(starts.length > 0 ? { firstSession: starts[0], lastSession: starts[starts.length - 1] } : {}),
	};
}
