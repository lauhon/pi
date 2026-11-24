import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestSession, findPending, loadProcessed, saveProcessed, type Processed } from "./sessions.ts";
import { applyOps, loadItems, prune, saveItems, today } from "./store.ts";
import { WRITER_SYSTEM, buildWriterPrompt, knownItemsFor, parseWriterOps } from "./writer.ts";

export interface Config {
	/** provider/model for regular runs */
	writerModel: string;
	/** provider/model for the first run, which backfills history */
	backfillModel: string;
	/** how far back sessions are considered at all */
	maxAgeDays: number;
	minIdleMinutes: number;
	logseqDir: string;
}

export const DEFAULT_CONFIG: Config = {
	writerModel: "anthropic/claude-sonnet-5-5",
	backfillModel: "anthropic/claude-haiku-5-5",
	maxAgeDays: 14,
	minIdleMinutes: 30,
	logseqDir: path.join(os.homedir(), "Documents", "Notes", "logseq-notes"),
};

export function loadConfig(root: string): Config {
	const file = path.join(root, "config.json");
	if (!existsSync(file)) return DEFAULT_CONFIG;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return DEFAULT_CONFIG;
	}
}

const LOCK_STALE_MS = 30 * 60_000;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Two pi windows starting together must not process the same sessions twice. */
export function acquireLock(root: string, now: number): boolean {
	mkdirSync(root, { recursive: true });
	const file = path.join(root, "lock");
	if (existsSync(file)) {
		try {
			const { pid, ts } = JSON.parse(readFileSync(file, "utf8")) as { pid: number; ts: number };
			if (pid !== process.pid && pidAlive(pid) && now - ts < LOCK_STALE_MS) return false;
		} catch {
			// unreadable lock: treat as stale
		}
		rmSync(file, { force: true });
	}
	try {
		writeFileSync(file, JSON.stringify({ pid: process.pid, ts: now }), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

export function releaseLock(root: string): void {
	const file = path.join(root, "lock");
	try {
		const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
		if (pid === process.pid) rmSync(file, { force: true });
	} catch {
		// already gone
	}
}

export interface CompleteResult {
	text: string;
	cost: number;
}

export interface RunDeps {
	root: string;
	sessionsRoot: string;
	exclude: Set<string>;
	config: Config;
	now: () => number;
	complete: (model: string, system: string, prompt: string, signal: AbortSignal) => Promise<CompleteResult>;
	onProgress?: (done: number, total: number) => void;
	signal: AbortSignal;
}

export interface RunReport {
	status: "locked" | "idle" | "done" | "aborted";
	sessions: number;
	skipped: number;
	failed: number;
	added: string[];
	updated: string[];
	pruned: number;
	cost: number;
	model?: string;
	firstError?: string;
}

export async function runWriter(deps: RunDeps): Promise<RunReport> {
	const report: RunReport = { status: "idle", sessions: 0, skipped: 0, failed: 0, added: [], updated: [], pruned: 0, cost: 0 };
	if (!acquireLock(deps.root, deps.now())) return { ...report, status: "locked" };
	try {
		const processed: Processed = loadProcessed(deps.root) ?? {};
		const backfillMarker = path.join(deps.root, "backfill-done");
		const backfilling = !existsSync(backfillMarker);
		const model = backfilling ? deps.config.backfillModel : deps.config.writerModel;
		report.model = model;
		const pending = findPending(deps.sessionsRoot, processed, {
			now: deps.now(),
			minIdleMs: deps.config.minIdleMinutes * 60_000,
			maxAgeDays: deps.config.maxAgeDays,
			exclude: deps.exclude,
		});

		let items = loadItems(deps.root);
		const before = items.length;
		items = prune(items, deps.now());
		report.pruned = before - items.length;

		for (const [n, s] of pending.entries()) {
			if (deps.signal.aborted) {
				report.status = "aborted";
				break;
			}
			deps.onProgress?.(n, pending.length);
			let raw: string;
			try {
				raw = readFileSync(s.file, "utf8");
			} catch {
				continue;
			}
			const digest = digestSession(raw);
			if (digest.userMessages === 0 || /^\/(private\/)?(tmp|var)\//.test(digest.cwd)) {
				processed[s.file] = s.size;
				report.skipped++;
				continue;
			}
			const since = today(deps.now() - 14 * 86_400_000);
			const known = knownItemsFor(items, since);
			let result: CompleteResult;
			try {
				result = await deps.complete(model, WRITER_SYSTEM, buildWriterPrompt(digest, known), deps.signal);
			} catch (e) {
				if (deps.signal.aborted) {
					report.status = "aborted";
					break;
				}
				report.failed++;
				report.firstError ??= e instanceof Error ? e.message : String(e);
				continue;
			}
			report.cost += result.cost;
			const ops = parseWriterOps(result.text, new Set(items.map((i) => i.id)));
			// Date items by when the work happened, so ages and pruning stay right during a backfill.
			const applied = applyOps(items, ops, Math.min(s.mtimeMs, deps.now()), { cwd: digest.cwd || undefined, link: s.file });
			items = applied.items;
			for (const id of applied.added) if (!report.added.includes(id)) report.added.push(id);
			for (const id of applied.updated) if (!report.updated.includes(id) && !report.added.includes(id)) report.updated.push(id);
			processed[s.file] = s.size;
			report.sessions++;
			// Save after every session so an abort or crash loses at most one call.
			saveItems(deps.root, items);
			saveProcessed(deps.root, processed);
		}
		if (report.status !== "aborted") {
			report.status = "done";
			if (backfilling) writeFileSync(backfillMarker, new Date(deps.now()).toISOString());
		}
		saveItems(deps.root, items);
		saveProcessed(deps.root, processed);
		return report;
	} finally {
		releaseLock(deps.root);
	}
}

export function summarize(r: RunReport): string | undefined {
	if (r.status === "locked") return undefined;
	const parts: string[] = [];
	if (r.added.length) parts.push(`${r.added.length} new`);
	if (r.updated.length) parts.push(`${r.updated.length} updated`);
	if (r.pruned) parts.push(`${r.pruned} pruned`);
	if (!r.sessions && !parts.length && !r.failed) return undefined;
	let s = `work-memory: ${r.sessions} session${r.sessions === 1 ? "" : "s"} → ${parts.length ? parts.join(", ") : "no changes"}`;
	if (r.cost) s += ` ($${r.cost.toFixed(2)})`;
	if (r.failed) s += `, ${r.failed} failed${r.firstError ? `: ${r.firstError.slice(0, 120)}` : ""}`;
	if (r.status === "aborted") s += " (stopped early, continues next start)";
	return s;
}
