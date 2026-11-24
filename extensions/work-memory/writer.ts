import path from "node:path";
import type { Digest } from "./sessions.ts";
import type { Item, ItemOp } from "./store.ts";

export const WRITER_SYSTEM = `You maintain a short, high-level log of a developer's work items across coding-agent sessions.
You get one finished session (a digest: user messages "U", final assistant answers "A", compaction summaries, git/jira commands) and the current list of known items.

Decide which work items this session touched and return changes as a JSON array. Each element:
{"id": "<existing id, only when this session continues that item>", "title": "<short title, max 70 chars, include Jira key if any>", "status": "<free text, max 120 chars: where it ended and what is left>", "done": <true|false>, "links": ["<Jira keys, PR URLs, branch names>"]}

Rules:
- One item = one piece of work someone would track (a ticket, a feature, an investigation, a migration). Not individual steps.
- Prefer updating an existing item (set its id) over creating a near-duplicate. Match by Jira key, repo, and topic.
- For an existing item, only include fields that changed; always include "status".
- done=true only when the work is clearly finished (merged, deployed, answered, abandoned on purpose). Unclear means not done.
- Tooling problems (expired logins, harness or agent setup issues, workarounds) are not items. Mention them in the status of the item they block. Only make them an item when fixing the tooling was the goal of the session.
- Skip trivial sessions: quick questions, tests of the harness, chit-chat, one-off lookups with nothing left to do. Return [] for those.
- Usually 0-2 elements per session. Never more than 4.
- Status says what is left or what it waits on, not what was done in detail.
- Reply with the JSON array only, no prose, no code fence.`;

export function renderKnownItems(items: Item[], max = 60): string {
	if (!items.length) return "(none yet)";
	return items
		.slice(0, max)
		.map((i) => {
			const repo = i.cwd ? ` @${path.basename(i.cwd)}` : "";
			const refs = i.links.filter((l) => !l.endsWith(".jsonl")).slice(-3);
			return `- id=${i.id}${repo} [${i.done ? "done" : "open"}] ${i.title}: ${i.status}${refs.length ? ` (${refs.join(" ")})` : ""}`;
		})
		.join("\n");
}

/** Items worth showing the writer: all open ones plus recently finished ones that might be reopened. */
export function knownItemsFor(items: Item[], updatedSince: string): Item[] {
	return [...items]
		.filter((i) => !i.done || i.updated >= updatedSince)
		.sort((a, b) => Number(a.done) - Number(b.done) || b.updated.localeCompare(a.updated));
}

export function buildWriterPrompt(digest: Digest, known: Item[]): string {
	return `Known items:\n${renderKnownItems(known)}\n\nSession digest:\n${digest.text}`;
}

function str(v: unknown, max: number): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Tolerates a code fence or leading prose; anything unparseable yields no ops rather than an error. */
export function parseWriterOps(text: string, knownIds: Set<string>): ItemOp[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end < start) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	const ops: ItemOp[] = [];
	for (const r of raw.slice(0, 4)) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		const id = str(o.id, 80);
		const op: ItemOp = {};
		if (id && knownIds.has(id)) op.id = id;
		const title = str(o.title, 100);
		if (title) op.title = title;
		const status = str(o.status, 200);
		if (status) op.status = status;
		if (typeof o.done === "boolean") op.done = o.done;
		if (Array.isArray(o.links)) op.links = o.links.filter((l): l is string => typeof l === "string" && l.length <= 200).slice(0, 6);
		if (!op.id && !op.title) continue;
		ops.push(op);
	}
	return ops;
}
