/**
 * Work memory for the attention view: list, filter and update `items.jsonl` through the store's own
 * functions (loadItems, applyOps, saveItems, prune). The file stays the source of truth; every update
 * carries the version (sha256 of the file bytes) the page last read, and a changed file is a 409.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { applyOps, itemsPath, loadItems, PRUNE_AFTER_DAYS, prune, saveItems, searchItems, today, type Item } from "../../../extensions/work-memory/store.ts";

export const STALE_DAYS = 7;
export const RISK_DAYS = 7;
export const KEEP_MORE_DAYS = 30;
const DAY = 86_400_000;
export const JIRA_BASE = "https://redbull-gms.atlassian.net/browse/";

export class MemoryError extends Error {
	status: number;
	extra: Record<string, unknown>;
	constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
		super(message);
		this.status = status;
		this.extra = extra;
	}
}

export function memoryVersion(root: string): string {
	try {
		return createHash("sha256").update(readFileSync(itemsPath(root))).digest("hex");
	} catch {
		return "";
	}
}

// ── links ──────────────────────────────────────────────────────────────────

export type LinkView =
	| { kind: "jira"; label: string; href: string }
	| { kind: "pr"; label: string; href: string }
	| { kind: "url"; label: string; href: string }
	| { kind: "session"; label: string; ref: string }
	| { kind: "text"; label: string };

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const GITHUB_PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/**
 * Jira key, GitHub PR, other http(s) URL, session file, or plain text. A local path is never a
 * link: a session file becomes one only when `refOf` says it is a served session, and then it carries
 * the opaque ref, not the path.
 */
export function classifyLink(link: string, refOf: (path: string) => string | null): LinkView {
	const text = link.trim();
	if (JIRA_KEY.test(text)) return { kind: "jira", label: text, href: `${JIRA_BASE}${text}` };
	const pr = GITHUB_PR.exec(text);
	if (pr) return { kind: "pr", label: `PR #${pr[3]}`, href: `https://github.com/${pr[1]}/${pr[2]}/pull/${pr[3]}` };
	if (/^https?:\/\//i.test(text)) {
		try {
			const url = new URL(text);
			if (url.protocol === "https:" || url.protocol === "http:") return { kind: "url", label: url.host, href: url.href };
		} catch {
			// not a URL after all
		}
		return { kind: "text", label: text.slice(0, 120) };
	}
	if (text.endsWith(".jsonl")) {
		const ref = refOf(text);
		return ref ? { kind: "session", label: "Last session", ref } : { kind: "text", label: "Session file (not available here)" };
	}
	return { kind: "text", label: text.slice(0, 120) };
}

// ── items ──────────────────────────────────────────────────────────────────

function daysSince(day: string, now: number): number {
	return Math.floor((now - Date.parse(`${day}T00:00:00Z`)) / DAY);
}

function addDays(day: string, n: number): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** Day the item drops by prune(): after 60 days without update, and after keepUntil. Null for "forever". */
export function prunesOn(item: Item): string | null {
	if (item.keepUntil === "forever") return null;
	const byAge = addDays(item.updated, PRUNE_AFTER_DAYS + 1);
	if (item.keepUntil && /^\d{4}-\d{2}-\d{2}$/.test(item.keepUntil)) {
		const byKeep = addDays(item.keepUntil, 1);
		return byKeep > byAge ? byKeep : byAge;
	}
	return byAge;
}

export interface ItemView {
	id: string;
	title: string;
	status: string;
	done: boolean;
	cwd: string | null;
	repo: string | null;
	created: string;
	updated: string;
	keepUntil: string | null;
	links: LinkView[];
	sessionLinks: Extract<LinkView, { kind: "session" }>[];
	/** Open and not updated for 7 days or more. */
	stale: boolean;
	/** Open and dropped by prune() within 7 days (or already past its date). */
	atRisk: boolean;
	prunesOn: string | null;
}

export function itemView(item: Item, now: number, refOf: (path: string) => string | null): ItemView {
	const all = item.links.map((l) => classifyLink(l, refOf));
	const sessionLinks = all.filter((l): l is Extract<LinkView, { kind: "session" }> => l.kind === "session");
	sessionLinks.forEach((l, i) => {
		l.label = i === sessionLinks.length - 1 ? "Last session" : "Earlier session";
	});
	return {
		id: item.id,
		title: item.title,
		status: item.status,
		done: item.done,
		cwd: item.cwd ?? null,
		repo: item.cwd ? basename(item.cwd) : null,
		created: item.created,
		updated: item.updated,
		keepUntil: item.keepUntil ?? null,
		links: all.filter((l) => l.kind !== "session"),
		sessionLinks,
		stale: !item.done && daysSince(item.updated, now) >= STALE_DAYS,
		atRisk: !item.done && prune([item], now + RISK_DAYS * DAY).length === 0,
		prunesOn: prunesOn(item),
	};
}

export const STATES = ["relevant", "stale", "open", "done"] as const;
export type MemoryState = (typeof STATES)[number];

export interface MemoryQuery {
	query?: string;
	state?: string;
	repo?: string;
}

export interface MemoryList {
	items: ItemView[];
	version: string;
	readAt: number;
	skippedLines: number;
	/** Over all items, ignoring the query: for the header control and the filter tabs. */
	counts: { relevant: number; stale: number; open: number; done: number; atRisk: number };
}

function skipped(root: string): number {
	try {
		const lines = readFileSync(itemsPath(root), "utf8").split("\n").filter((l) => l.trim()).length;
		return Math.max(0, lines - loadItems(root).length);
	} catch {
		return 0;
	}
}

/**
 * relevant = open and updated within the last 7 days (still moving), stale = open and 7+ days
 * untouched, open = both, done = finished. Items at risk of pruning come first in every open list.
 */
export function listMemory(root: string, q: MemoryQuery, now: number, refOf: (path: string) => string | null): MemoryList {
	const state = (q.state ?? "relevant") as MemoryState;
	if (!STATES.includes(state)) throw new MemoryError(400, "bad state");
	if ((q.query ?? "").length > 200 || (q.repo ?? "").length > 300) throw new MemoryError(400, "bad query");
	const version = memoryVersion(root);
	const items = loadItems(root);
	const views = new Map(items.map((i) => [i.id, itemView(i, now, refOf)]));
	const all = [...views.values()];
	const counts = {
		relevant: all.filter((v) => !v.done && !v.stale).length,
		stale: all.filter((v) => v.stale).length,
		open: all.filter((v) => !v.done).length,
		done: all.filter((v) => v.done).length,
		atRisk: all.filter((v) => v.atRisk).length,
	};
	const matched = searchItems(items, { query: q.query, includeDone: true, limit: Number.MAX_SAFE_INTEGER });
	const picked = matched
		.map((i) => views.get(i.id)!)
		.filter((v) => (state === "done" ? v.done : state === "open" ? !v.done : state === "stale" ? v.stale : !v.done && !v.stale))
		.filter((v) => !q.repo || v.cwd === q.repo || v.repo === q.repo)
		.sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
	return { items: picked.slice(0, 300), version, readAt: now, skippedLines: skipped(root), counts };
}

/** Open items per exact session file, keyed by ref. */
export function sessionMemoryCounts(root: string, refOf: (path: string) => string | null): Map<string, number> {
	const out = new Map<string, number>();
	for (const item of loadItems(root)) {
		if (item.done) continue;
		const refs = new Set<string>();
		for (const l of item.links) if (l.trim().endsWith(".jsonl")) refs.add(refOf(l.trim()) ?? "");
		refs.delete("");
		for (const ref of refs) out.set(ref, (out.get(ref) ?? 0) + 1);
	}
	return out;
}

// ── update ─────────────────────────────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (d: unknown): d is string => {
	if (typeof d !== "string" || !DATE.test(d)) return false;
	const t = Date.parse(`${d}T00:00:00Z`);
	return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

export interface UpdateBody {
	id: string;
	version: string;
	done?: boolean;
	/** "forever", "+30d" (30 more days past the later of today and the current keepUntil), a date, or null to clear. */
	keepUntil?: string | null;
	/** Restores the previous `updated` day; used by Undo so reopening does not look like new activity. */
	updated?: string;
}

export function parseUpdate(body: unknown): UpdateBody {
	const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	if (typeof o.id !== "string" || !o.id || o.id.length > 200) throw new MemoryError(400, "bad id");
	if (typeof o.version !== "string" || !/^([0-9a-f]{64})?$/.test(o.version)) throw new MemoryError(400, "bad version");
	const out: UpdateBody = { id: o.id, version: o.version };
	if (o.done !== undefined) {
		if (typeof o.done !== "boolean") throw new MemoryError(400, "bad done");
		out.done = o.done;
	}
	if (o.keepUntil !== undefined) {
		if (o.keepUntil !== null && o.keepUntil !== "forever" && o.keepUntil !== "+30d" && !validDay(o.keepUntil)) throw new MemoryError(400, "bad keepUntil");
		out.keepUntil = o.keepUntil as string | null;
	}
	if (o.updated !== undefined) {
		if (!validDay(o.updated)) throw new MemoryError(400, "bad updated");
		out.updated = o.updated;
	}
	if (out.done === undefined && out.keepUntil === undefined) throw new MemoryError(400, "nothing to update");
	return out;
}

export function updateMemory(root: string, body: UpdateBody, now: number, refOf: (path: string) => string | null): { item: ItemView; version: string } {
	const current = memoryVersion(root);
	if (current !== body.version) throw new MemoryError(409, "work memory changed since you read it", { version: current });
	const items = loadItems(root);
	const existing = items.find((i) => i.id === body.id);
	if (!existing) throw new MemoryError(404, "unknown item");
	const day = today(now);
	let keep: string | null | undefined;
	if (body.keepUntil === "+30d") {
		if (existing.keepUntil === "forever") keep = "forever";
		else {
			const from = existing.keepUntil && validDay(existing.keepUntil) && existing.keepUntil > day ? existing.keepUntil : day;
			keep = addDays(from, KEEP_MORE_DAYS);
		}
	} else keep = body.keepUntil;
	const result = applyOps(items, [{ id: body.id, done: body.done, keepUntil: keep }], now);
	const next = result.items.find((i) => i.id === body.id)!;
	if (body.updated && body.updated <= day) next.updated = body.updated;
	if (memoryVersion(root) !== current) throw new MemoryError(409, "work memory changed since you read it", { version: memoryVersion(root) });
	saveItems(root, result.items);
	return { item: itemView(next, now, refOf), version: memoryVersion(root) };
}

export function memoryExists(root: string): boolean {
	return existsSync(itemsPath(root));
}
