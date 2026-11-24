import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./store.ts";

/** Session file path -> size in bytes when it was last processed. A grown file gets processed again. */
export type Processed = Record<string, number>;

export function processedPath(root: string): string {
	return path.join(root, "processed.json");
}

export function loadProcessed(root: string): Processed | undefined {
	const file = processedPath(root);
	if (!existsSync(file)) return undefined;
	try {
		const v: unknown = JSON.parse(readFileSync(file, "utf8"));
		return v && typeof v === "object" ? (v as Processed) : {};
	} catch {
		return {};
	}
}

export function saveProcessed(root: string, processed: Processed): void {
	writeFileAtomic(processedPath(root), JSON.stringify(processed, null, 1));
}

export interface PendingOptions {
	now: number;
	/** Sessions changed more recently than this may still be in use. */
	minIdleMs: number;
	/** Sessions older than this are ignored entirely. */
	maxAgeDays: number;
	/** Absolute paths never to process (e.g. the current session). */
	exclude: Set<string>;
}

export interface PendingSession {
	file: string;
	size: number;
	mtimeMs: number;
}

/**
 * Session dirs are named after the cwd ("--Users-x-repo--"). Temp dirs hold
 * subagent children and test runs, not the user's own work.
 */
export function isIgnoredSessionDir(name: string): boolean {
	return /^--(private-)?(tmp|var)(-|$)/.test(name);
}

export function findPending(sessionsRoot: string, processed: Processed, opts: PendingOptions): PendingSession[] {
	if (!existsSync(sessionsRoot)) return [];
	const minMtime = opts.now - opts.maxAgeDays * 86_400_000;
	const out: PendingSession[] = [];
	for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!dir.isDirectory() || isIgnoredSessionDir(dir.name)) continue;
		const dirPath = path.join(sessionsRoot, dir.name);
		for (const f of readdirSync(dirPath)) {
			if (!f.endsWith(".jsonl")) continue;
			const file = path.join(dirPath, f);
			if (opts.exclude.has(file)) continue;
			let st;
			try {
				st = statSync(file);
			} catch {
				continue;
			}
			if (st.mtimeMs < minMtime || opts.now - st.mtimeMs < opts.minIdleMs) continue;
			if (processed[file] === st.size) continue;
			out.push({ file, size: st.size, mtimeMs: st.mtimeMs });
		}
	}
	return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export interface Digest {
	cwd: string;
	start: string;
	name?: string;
	userMessages: number;
	text: string;
}

export interface DigestOptions {
	maxChars: number;
	headChars: number;
	maxCommands: number;
}

export const DEFAULT_DIGEST: DigestOptions = { maxChars: 20_000, headChars: 7_000, maxCommands: 25 };

const COMMAND_RE = /git (checkout|switch|commit|push|merge)|gh pr|acli|jira/;

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

function flat(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function textOf(content: unknown): string {
	if (typeof content === "string") return flat(content);
	if (!Array.isArray(content)) return "";
	return flat(
		content
			.filter((c): c is { type: "text"; text: string } => !!c && c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join(" "),
	);
}

/**
 * Keep what says "what was this about and where did it end": user text, final
 * assistant answers, compaction summaries, and git/gh/jira commands. Tool
 * output and thinking are about half the bytes and almost none of the signal.
 */
export function digestSession(raw: string, opts: DigestOptions = DEFAULT_DIGEST): Digest {
	const lines: string[] = [];
	let cwd = "";
	let start = "";
	let name: string | undefined;
	let userMessages = 0;
	let commands = 0;

	for (const line of raw.split("\n")) {
		if (!line) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (e.type === "session") {
			cwd = e.cwd ?? "";
			start = e.timestamp ?? "";
			lines.push(`# cwd=${cwd} start=${start}`);
		} else if (e.type === "session_info" && e.name) {
			name = e.name;
			lines.push(`# NAME: ${e.name}`);
		} else if (e.type === "compaction" && typeof e.summary === "string") {
			lines.push(`# COMPACTION: ${clip(flat(e.summary), 1500)}`);
		} else if (e.type === "message" && e.message?.role === "user") {
			const t = textOf(e.message.content);
			if (!t) continue;
			userMessages++;
			lines.push(`U[${String(e.timestamp ?? "").slice(5, 16)}]: ${clip(t, 600)}`);
		} else if (e.type === "message" && e.message?.role === "assistant") {
			const t = textOf(e.message.content);
			if (t && e.message.stopReason === "stop") lines.push(`A: ${clip(t, 500)}`);
			for (const c of Array.isArray(e.message.content) ? e.message.content : []) {
				const cmd = c?.type === "toolCall" && c.name === "bash" ? c.arguments?.command : undefined;
				if (typeof cmd === "string" && COMMAND_RE.test(cmd) && commands < opts.maxCommands) {
					commands++;
					lines.push(`  $ ${clip(flat(cmd), 160)}`);
				}
			}
		}
	}

	let text = lines.join("\n");
	if (text.length > opts.maxChars) {
		const tail = opts.maxChars - opts.headChars;
		text = `${text.slice(0, opts.headChars)}\n[...cut...]\n${text.slice(-tail)}`;
	}
	return { cwd, start, name, userMessages, text };
}
