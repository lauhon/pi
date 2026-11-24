import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Item {
	id: string;
	title: string;
	/** Free-text status, e.g. "PR open, waiting on review". */
	status: string;
	done: boolean;
	/** Repo/cwd the work happened in, if any. */
	cwd?: string;
	/** Jira keys, PR URLs, branches, session files. */
	links: string[];
	/** YYYY-MM-DD */
	created: string;
	/** YYYY-MM-DD */
	updated: string;
	/** YYYY-MM-DD; item survives pruning until this date. "forever" never prunes. */
	keepUntil?: string;
}

/** One change proposed by the writer model or the work_memory tool. */
export interface ItemOp {
	/** Existing item id; absent or unknown means "create". */
	id?: string;
	title?: string;
	status?: string;
	done?: boolean;
	links?: string[];
	cwd?: string;
	keepUntil?: string | null;
}

export interface ApplyResult {
	items: Item[];
	added: string[];
	updated: string[];
}

export const PRUNE_AFTER_DAYS = 60;

export function memoryRoot(): string {
	return process.env.WORK_MEMORY_DIR || path.join(os.homedir(), ".work-memory");
}

export function itemsPath(root: string): string {
	return path.join(root, "items.jsonl");
}

export function today(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

function daysBetween(fromDay: string, now: number): number {
	return Math.floor((now - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000);
}

function isItem(v: unknown): v is Item {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
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

/** Malformed lines are skipped, not fatal: the file is meant to be hand-editable. */
export function parseItems(text: string): Item[] {
	const items: Item[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const v: unknown = JSON.parse(line);
			if (isItem(v)) items.push(v);
		} catch {
			// hand-edit typo; keep the rest usable
		}
	}
	return items;
}

export function loadItems(root: string): Item[] {
	const file = itemsPath(root);
	if (!existsSync(file)) return [];
	return parseItems(readFileSync(file, "utf8"));
}

export function writeFileAtomic(file: string, content: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, file);
}

export function saveItems(root: string, items: Item[]): void {
	const sorted = [...items].sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
	writeFileAtomic(itemsPath(root), sorted.map((i) => JSON.stringify(i)).join("\n") + (sorted.length ? "\n" : ""));
}

export function prune(items: Item[], now: number, days = PRUNE_AFTER_DAYS): Item[] {
	const day = today(now);
	return items.filter((i) => {
		if (i.keepUntil === "forever" || (i.keepUntil && i.keepUntil >= day)) return true;
		return daysBetween(i.updated, now) <= days;
	});
}

export function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 28)
		.replace(/-+$/g, "");
	return slug || "item";
}

function uniqueId(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function mergeLinks(a: string[], b: string[] | undefined): string[] {
	if (!b?.length) return a;
	const out = [...a];
	for (const l of b) {
		const t = l.trim();
		if (t && !out.includes(t)) out.push(t);
	}
	return out.slice(-12);
}

export function applyOps(items: Item[], ops: ItemOp[], now: number, defaults: { cwd?: string; link?: string } = {}): ApplyResult {
	const day = today(now);
	const byId = new Map(items.map((i) => [i.id, { ...i, links: [...i.links] }]));
	const added: string[] = [];
	const updated: string[] = [];

	for (const op of ops) {
		const existing = op.id ? byId.get(op.id) : undefined;
		const extraLinks = defaults.link ? [...(op.links ?? []), defaults.link] : op.links;
		if (existing) {
			if (op.title?.trim()) existing.title = op.title.trim();
			if (op.status?.trim()) existing.status = op.status.trim();
			if (typeof op.done === "boolean") existing.done = op.done;
			if (op.cwd) existing.cwd = op.cwd;
			if (op.keepUntil === null) delete existing.keepUntil;
			else if (op.keepUntil) existing.keepUntil = op.keepUntil;
			existing.links = mergeLinks(existing.links, extraLinks);
			if (day > existing.updated) existing.updated = day;
			if (!updated.includes(existing.id) && !added.includes(existing.id)) updated.push(existing.id);
			continue;
		}
		const title = op.title?.trim();
		if (!title) continue;
		const id = uniqueId(slugify(title), new Set(byId.keys()));
		const item: Item = {
			id,
			title,
			status: op.status?.trim() || "started",
			done: op.done ?? false,
			links: mergeLinks([], extraLinks),
			created: day,
			updated: day,
		};
		const cwd = op.cwd ?? defaults.cwd;
		if (cwd) item.cwd = cwd;
		if (op.keepUntil) item.keepUntil = op.keepUntil;
		byId.set(id, item);
		added.push(id);
	}
	return { items: [...byId.values()], added, updated };
}

export interface IndexLimits {
	here: number;
	elsewhere: number;
	recentDone: number;
	recentDoneDays: number;
	lineChars: number;
}

export const DEFAULT_INDEX_LIMITS: IndexLimits = {
	here: 5,
	elsewhere: 10,
	recentDone: 3,
	recentDoneDays: 7,
	lineChars: 120,
};

function clip(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function age(i: Item, now: number): string {
	return `${Math.max(0, daysBetween(i.updated, now))}d`;
}

function sameRepo(itemCwd: string | undefined, cwd: string): boolean {
	return !!itemCwd && (itemCwd === cwd || cwd.startsWith(`${itemCwd}/`));
}

/** The compact block injected into the system prompt. Empty string when there is nothing to show. */
export function renderIndex(items: Item[], cwd: string, now: number, limits: IndexLimits = DEFAULT_INDEX_LIMITS): string {
	const byRecent = [...items].sort((a, b) => b.updated.localeCompare(a.updated));
	const open = byRecent.filter((i) => !i.done);
	const here = open.filter((i) => sameRepo(i.cwd, cwd));
	const elsewhere = open.filter((i) => !sameRepo(i.cwd, cwd));
	const done = byRecent.filter((i) => i.done && daysBetween(i.updated, now) <= limits.recentDoneDays).slice(0, limits.recentDone);
	if (!open.length && !done.length) return "";

	const line = (i: Item, withRepo: boolean) => {
		const repo = withRepo && i.cwd ? ` (${path.basename(i.cwd)})` : "";
		return `- [${i.id}] ${clip(`${i.title}${repo}: ${i.status}`, limits.lineChars)} (${age(i, now)})`;
	};
	const out = ["Open work items from earlier sessions. Use the work_memory tool to search older/done items or update one."];
	if (here.length) {
		out.push(`here (${path.basename(cwd)}):`);
		out.push(...here.slice(0, limits.here).map((i) => line(i, false)));
	}
	if (elsewhere.length) {
		out.push(here.length ? "elsewhere:" : "open:");
		out.push(...elsewhere.slice(0, limits.elsewhere).map((i) => line(i, true)));
	}
	const hidden = Math.max(0, here.length - limits.here) + Math.max(0, elsewhere.length - limits.elsewhere);
	if (hidden) out.push(`+${hidden} more open`);
	if (done.length) out.push(`recently done: ${done.map((i) => `${clip(i.title, 60)} (${age(i, now)})`).join(" · ")}`);
	return out.join("\n");
}

export interface SearchQuery {
	query?: string;
	cwd?: string;
	includeDone?: boolean;
	limit?: number;
}

export function searchItems(items: Item[], q: SearchQuery): Item[] {
	const terms = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	return [...items]
		.filter((i) => q.includeDone || !i.done)
		.filter((i) => !q.cwd || sameRepo(i.cwd, q.cwd) || (i.cwd ?? "").includes(q.cwd))
		.filter((i) => {
			if (!terms.length) return true;
			const hay = `${i.id} ${i.title} ${i.status} ${i.cwd ?? ""} ${i.links.join(" ")}`.toLowerCase();
			return terms.every((t) => hay.includes(t));
		})
		.sort((a, b) => b.updated.localeCompare(a.updated))
		.slice(0, q.limit ?? 15);
}

export function formatItem(i: Item, now: number): string {
	const flags = [i.done ? "done" : "open", age(i, now)];
	if (i.keepUntil) flags.push(`keep:${i.keepUntil}`);
	const repo = i.cwd ? ` @${path.basename(i.cwd)}` : "";
	const refs = i.links.filter((l) => !l.endsWith(".jsonl")).slice(-4);
	const lastSession = i.links.filter((l) => l.endsWith(".jsonl")).at(-1);
	const links = refs.length ? ` | ${refs.join(" ")}` : "";
	const session = lastSession ? `\n  last session: ${lastSession}` : "";
	return `- [${i.id}] ${i.title}${repo}: ${i.status} (${flags.join(", ")})${links}${session}`;
}
