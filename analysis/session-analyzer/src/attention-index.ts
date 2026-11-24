/**
 * The /api/attention payload and the writers behind /api/steer and /api/memory. serve.ts does
 * the HTTP; this module does the work, so tests can call it without a socket.
 */
import { linkSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	attentionDir,
	catchKey,
	extractCatches,
	extractOutcomes,
	lastShape,
	linkOutcomes,
	nameOf,
	projectOf,
	readVerdicts,
	savingFor,
	statusFrom,
	STEER_PREFIX,
	subRunInfo,
	totalCost,
	type Catch,
	type Outcome,
	type Saving,
	type Shape,
	type Status,
} from "./attention.ts";
import { loadSession } from "./load.ts";

export interface Summary {
	id: string;
	path: string;
	cwd: string;
	project: string;
	name: string | null;
	firstMs: number;
	cost: number;
	contextTokens: number;
	shape: Shape;
	mtime: number;
	size: number;
	catches: (Catch & { saving: Saving | null })[];
	outcomes: Outcome[];
	sub: { name: string; parentId: string; runDir: string } | null;
}

const summaries = new Map<string, Summary>();

export function clearSummaries(): void {
	summaries.clear();
}

export function summarize(path: string, mtime: number, size: number): Summary | null {
	const hit = summaries.get(path);
	if (hit && hit.mtime === mtime && hit.size === size) return hit;
	let session;
	try {
		session = loadSession(path);
	} catch {
		return null;
	}
	const catches = extractCatches(session);
	const outcomes = linkOutcomes(catches, extractOutcomes(session));
	const points = session.requestPoints;
	const summary: Summary = {
		id: session.id,
		path,
		cwd: session.cwd,
		project: projectOf(session, path),
		name: nameOf(session),
		firstMs: Date.parse(session.entries[0]?.timestamp ?? session.startedAt) || mtime,
		cost: totalCost(session),
		contextTokens: points[points.length - 1]?.usage.contextTokens ?? 0,
		shape: lastShape(session),
		mtime,
		size,
		catches: catches.map((c) => ({ ...c, saving: savingFor(c, outcomes, session) })),
		outcomes,
		sub: subRunInfo(path),
	};
	summaries.set(path, summary);
	return summary;
}

export function listSummaries(files: { path: string; mtimeMs: number }[]): Summary[] {
	const out: Summary[] = [];
	for (const f of files) {
		let size: number;
		try {
			size = statSync(f.path).size;
		} catch {
			continue;
		}
		const s = summarize(f.path, f.mtimeMs, size);
		if (s) out.push(s);
	}
	return out;
}

export interface SessionView {
	id: string;
	path: string;
	project: string;
	name: string | null;
	status: Status;
	ageDays: number;
	cost: number;
	mtime: number;
	contextTokens: number;
	subs: SessionView[];
	/** Sub-run whose parent is not among the listed sessions. */
	orphan?: boolean;
}

function view(s: Summary, now: number): SessionView {
	return {
		id: s.id,
		path: s.path,
		project: s.project,
		name: s.sub ? s.sub.name : s.name,
		status: statusFrom(s.shape, s.mtime, now),
		ageDays: Math.max(0, (now - s.firstMs) / 86_400_000),
		cost: s.cost,
		mtime: s.mtime,
		contextTokens: s.contextTokens,
		subs: [],
	};
}

export interface AttentionPayload {
	now: number;
	focused: string | null;
	sessions: SessionView[];
	catches: (Catch & { key: string; project: string; name: string | null; verdict: "useful" | "noise" | null; saving: Saving | null })[];
	outcomes: (Outcome & { project: string; name: string | null })[];
	stats: { catches: number; useful: number; noise: number; esc: number; rewind: number; steer: number };
}

export function buildAttention(all: Summary[], hours: number, focused: string | null, now = Date.now(), dir = attentionDir()): AttentionPayload {
	const cutoff = now - hours * 3_600_000;
	const views = new Map<string, SessionView>();
	for (const s of all) if (!s.sub) views.set(s.id, view(s, now));
	const sessions = [...views.values()];
	for (const s of all) {
		if (!s.sub) continue;
		const v = view(s, now);
		const parent = views.get(s.sub.parentId);
		if (parent) parent.subs.push(v);
		else {
			v.orphan = true;
			sessions.push(v);
		}
	}
	const byRecent = (a: SessionView, b: SessionView) => b.mtime - a.mtime;
	sessions.sort(byRecent);
	for (const v of sessions) v.subs.sort(byRecent);

	const verdicts = readVerdicts(dir);
	const catches: AttentionPayload["catches"] = [];
	const outcomes: AttentionPayload["outcomes"] = [];
	for (const s of all) {
		const label = { project: s.project, name: s.sub ? s.sub.name : s.name };
		for (const c of s.catches) {
			if (Date.parse(c.timestamp) < cutoff) continue;
			catches.push({ ...c, key: catchKey(c), ...label, verdict: verdicts.get(catchKey(c))?.verdict ?? null });
		}
		for (const o of s.outcomes) if (Date.parse(o.timestamp) >= cutoff) outcomes.push({ ...o, ...label });
	}
	const newest = (a: { timestamp: string }, b: { timestamp: string }) => Date.parse(b.timestamp) - Date.parse(a.timestamp);
	catches.sort(newest);
	outcomes.sort(newest);
	const count = (t: Outcome["type"]) => outcomes.filter((o) => o.type === t).length;
	return {
		now,
		focused,
		sessions: sessions.filter((v) => v.mtime >= cutoff || v.subs.some((x) => x.mtime >= cutoff)),
		catches,
		outcomes,
		stats: {
			catches: catches.length,
			useful: catches.filter((c) => c.verdict === "useful").length,
			noise: catches.filter((c) => c.verdict === "noise").length,
			esc: count("esc"),
			rewind: count("rewind"),
			steer: count("steer"),
		},
	};
}

// ── focus ──────────────────────────────────────────────────────────────────

/** "π - <name> - <project>" or "π - <project>". */
export function parseTitle(title: string): { name: string | null; project: string } | null {
	const m = /^π - (.+)$/.exec(title.trim());
	if (!m) return null;
	const rest = m[1];
	const i = rest.lastIndexOf(" - ");
	return i < 0 ? { name: null, project: rest } : { name: rest.slice(0, i), project: rest.slice(i + 3) };
}

type Json = Record<string, unknown>;
const on = (o: Json) => o.active === true || o.focused === true || o.selected === true;
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => typeof x === "object" && x !== null) as Json[]) : []);

/**
 * Title of the pi tab the user is looking at, from `cmux tree --all --json`. Each visible window
 * shows the selected surface of its focused pane; the active window wins, but the view itself often
 * is the active window (spare monitor), so a non-pi title falls through to the other windows.
 */
export function focusedTitle(tree: unknown): string | null {
	if (typeof tree !== "object" || tree === null) return null;
	const windows = list((tree as Json).windows)
		.filter((w) => w.visible !== false)
		.sort((a, b) => Number(on(b)) - Number(on(a)));
	for (const w of windows) {
		for (const ws of list(w.workspaces)) {
			if (!on(ws)) continue;
			for (const p of list(ws.panes)) {
				if (!on(p)) continue;
				for (const sf of list(p.surfaces)) {
					if (on(sf) && typeof sf.title === "string" && parseTitle(sf.title)) return sf.title;
				}
			}
		}
	}
	return null;
}

export function matchFocused(title: string | null, all: Summary[]): string | null {
	const t = title ? parseTitle(title) : null;
	if (!t) return null;
	const mains = all.filter((s) => !s.sub && s.project === t.project).sort((a, b) => b.mtime - a.mtime);
	const hit = t.name === null ? mains.find((s) => !s.name) : mains.find((s) => s.name === t.name);
	return hit?.id ?? null;
}

// ── steer ──────────────────────────────────────────────────────────────────

let steerCounter = 0;

/** Write to a temp name, then link into place: readers poll `*.md` and must never see a partial file. */
function writeNew(file: string, text: string): boolean {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	try {
		linkSync(tmp, file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		unlinkSync(tmp);
	}
}

/** `$PI_ATTENTION_DIR/steer/<sessionId>/<timestamp>-<n>.md`; the extension adds the prefix. */
export function writeSteer(sessionId: string, text: string, dir = attentionDir(), now = Date.now()): string {
	const target = join(dir, "steer", sessionId);
	mkdirSync(target, { recursive: true });
	for (;;) {
		const file = join(target, `${String(now).padStart(13, "0")}-${String(++steerCounter).padStart(4, "0")}.md`);
		if (writeNew(file, text)) return file;
	}
}

/** Next sequence the way `sub resume` does: highest of NNNNNN.md, .md.sent, .md.rejected, plus one. */
export function writeSubInbox(runDir: string, text: string): string {
	const inbox = join(runDir, "inbox");
	mkdirSync(inbox, { recursive: true });
	let max = 0;
	for (const name of readdirSync(inbox)) {
		const m = /^(\d+)\.md(\.(sent|rejected))?$/.exec(name);
		if (m) max = Math.max(max, Number.parseInt(m[1], 10));
	}
	for (let seq = max + 1; ; seq++) {
		const name = `${String(seq).padStart(6, "0")}.md`;
		const taken = [name, `${name}.sent`, `${name}.rejected`].some((n) => {
			try {
				statSync(join(inbox, n));
				return true;
			} catch {
				return false;
			}
		});
		if (!taken && writeNew(join(inbox, name), `${STEER_PREFIX}${text}`)) return join(inbox, name);
	}
}
