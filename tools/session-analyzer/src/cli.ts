/**
 * `npm run analyze -- <subcommand> [args]`
 *
 *   list <dir>...              one row per session file under the dirs (recursive)
 *   inspect <file>             one row per request point, plus the facts the spec's open questions ask for
 *   sanitize <file> [--out p]  write a same-size copy with every text body replaced (fixtures only)
 *
 * Output is a terminal table by default, or JSON with --json.
 */
import { existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { findSessionFiles, loadSession, replaySystemMessages } from "./load.ts";
import { fmtCost, fmtDate, fmtDuration, fmtInt, fmtPct, fmtTokens, renderTable, sessionJson, shortModel, toJson, type Row } from "./report.ts";
import { sanitizeJsonl } from "./sanitize.ts";
import type { RequestPoint, Session } from "./types.ts";

const USAGE = `usage: npm run analyze -- <subcommand> [args] [--json]

  list <dir>...                sessions under the dirs (recursive), one row each
  inspect <file>               request points of one session
  sanitize <file> [--out path] same-size copy with text bodies replaced
`;

export interface CliOptions {
	json: boolean;
	out?: string;
	turn?: number;
	request?: number;
	model?: string;
	since?: string;
	until?: string;
	limit?: number;
}

export interface CliResult {
	stdout: string;
	stderr: string;
	code: number;
}

export function run(argv: string[]): CliResult {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			options: {
				json: { type: "boolean", default: false },
				out: { type: "string" },
				turn: { type: "string" },
				request: { type: "string" },
				model: { type: "string" },
				since: { type: "string" },
				until: { type: "string" },
				limit: { type: "string" },
			},
			allowPositionals: true,
		});
	} catch (error) {
		return { stdout: "", stderr: `${(error as Error).message}\n${USAGE}`, code: 2 };
	}
	const [command, ...positionals] = parsed.positionals;
	try {
		const options: CliOptions = {
			json: parsed.values.json === true,
			out: parsed.values.out,
			turn: optionalInt(parsed.values.turn),
			request: optionalInt(parsed.values.request),
			model: parsed.values.model,
			since: parsed.values.since,
			until: parsed.values.until,
			limit: optionalInt(parsed.values.limit),
		};
		switch (command) {
			case "list":
				return list(requirePaths(positionals, "list <dir>..."), options);
			case "inspect":
				return inspect(requirePath(positionals[0], "inspect <file>"), options);
			case "sanitize":
				return sanitize(requirePath(positionals[0], "sanitize <file>"), options);
			case undefined:
			case "help":
			case "--help":
				return { stdout: USAGE, stderr: "", code: command === undefined ? 2 : 0 };
			default:
				return { stdout: "", stderr: `unknown subcommand: ${command}\n${USAGE}`, code: 2 };
		}
	} catch (error) {
		return { stdout: "", stderr: `${(error as Error).message}\n`, code: 1 };
	}
}

function optionalInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) throw new Error(`not an integer: ${value}`);
	return parsed;
}

function requirePath(value: string | undefined, form: string): string {
	if (!value) throw new Error(`missing argument: ${form}`);
	if (!existsSync(value)) throw new Error(`no such path: ${value}`);
	return value;
}

function requirePaths(values: string[], form: string): string[] {
	if (values.length === 0) throw new Error(`missing argument: ${form}`);
	return values.map((value) => requirePath(value, form));
}

// ── list ───────────────────────────────────────────────────────────────────

export interface LoadedSession {
	session: Session;
	/** The root it was found under, for display. */
	root: string;
}

/** Every session under the given roots (files or directories), filtered by the options. */
export function loadDirectories(roots: string[], options: CliOptions): { loaded: LoadedSession[]; warnings: string[] } {
	const loaded: LoadedSession[] = [];
	const warnings: string[] = [];
	for (const root of roots) {
		for (const file of findSessionFiles(root)) {
			try {
				const session = loadSession(file);
				if (keepSession(session, options)) loaded.push({ session, root });
			} catch (error) {
				warnings.push(`skipped ${file}: ${(error as Error).message}`);
			}
		}
	}
	return { loaded, warnings };
}

export function displayPath(entry: LoadedSession): string {
	return statSync(entry.root).isFile() ? entry.root : relative(entry.root, entry.session.path);
}

function keepSession(session: Session, options: CliOptions): boolean {
	if (options.since && session.startedAt < options.since) return false;
	if (options.until && session.startedAt > options.until) return false;
	if (options.model && !session.requestPoints.some((rp) => rp.model.includes(options.model!))) return false;
	return true;
}

function list(roots: string[], options: CliOptions): CliResult {
	const { loaded, warnings } = loadDirectories(roots, options);
	const sessions = loaded.map((entry) => entry.session);
	const rows: Row[] = loaded.map(({ session }, i) => ({
		file: displayPath(loaded[i]),
		started: fmtDate(session.startedAt),
		duration: fmtDuration(session.durationMs),
		turns: session.turns.length - 1,
		requests: session.requestPoints.length,
		models: distinct(session.requestPoints.map((rp) => shortModel(rp.model))).join(","),
		cost: fmtCost(sessionCost(session)),
		peakCtx: fmtTokens(peakContext(session)),
		compactions: session.compactions.length,
		forks: session.forks.length,
	}));
	if (options.json) {
		return { stdout: `${toJson(sessions.map(listJson))}\n`, stderr: warnings.join("\n"), code: 0 };
	}
	const table = renderTable(
		[
			{ key: "file", label: "file", max: 60 },
			{ key: "started", label: "started" },
			{ key: "duration", label: "dur", align: "right" },
			{ key: "turns", label: "turns", align: "right" },
			{ key: "requests", label: "req", align: "right" },
			{ key: "models", label: "models", max: 30 },
			{ key: "cost", label: "cost", align: "right" },
			{ key: "peakCtx", label: "peak ctx", align: "right" },
			{ key: "compactions", label: "comp", align: "right" },
			{ key: "forks", label: "forks", align: "right" },
		],
		rows,
	);
	const footer = `${sessions.length} sessions, ${fmtInt(sessions.reduce((n, s) => n + s.requestPoints.length, 0))} requests, ${fmtCost(sessions.reduce((n, s) => n + sessionCost(s), 0))}`;
	return { stdout: `${table}\n${footer}\n`, stderr: warnings.join("\n"), code: 0 };
}

function listJson(session: Session): Row {
	return {
		path: session.path,
		id: session.id,
		version: session.version,
		cwd: session.cwd,
		parentSession: session.parentSession ?? null,
		startedAt: session.startedAt,
		durationMs: session.durationMs,
		turns: session.turns.length - 1,
		requests: session.requestPoints.length,
		models: distinct(session.requestPoints.map((rp) => rp.model)),
		cost: sessionCost(session),
		peakContextTokens: peakContext(session),
		compactions: session.compactions.length,
		forks: session.forks.length,
	};
}

export function sessionCost(session: Session): number {
	return session.requestPoints.reduce((sum, rp) => sum + rp.usage.cost, 0);
}

export function peakContext(session: Session): number {
	return session.requestPoints.reduce((max, rp) => Math.max(max, rp.usage.contextTokens), 0);
}

function distinct<T>(values: T[]): T[] {
	return [...new Set(values)];
}

// ── inspect ────────────────────────────────────────────────────────────────

function inspect(file: string, options: CliOptions): CliResult {
	const session = loadSession(file);
	if (options.json) return { stdout: `${toJson(sessionJson(session))}\n`, stderr: "", code: 0 };
	const lines: string[] = [];
	lines.push(`session ${session.id}  version ${session.version}  cwd ${session.cwd}${session.parentSession ? `  parent ${session.parentSession}` : ""}`);
	lines.push(`entries ${session.entries.length} (${countList(session.entryTypeCounts)}); messages by role: ${countList(session.messageRoleCounts)}`);
	lines.push(
		`turns ${session.turns.length - 1}  requests ${session.requestPoints.length}  cost ${fmtCost(sessionCost(session))}  duration ${fmtDuration(session.durationMs)}  peak context ${fmtTokens(peakContext(session))}  compactions ${session.compactions.length}  forks ${session.forks.length}  branch summaries ${session.branchSummaryCount}`,
	);
	for (const fact of openQuestionFacts(session)) lines.push(fact);
	lines.push("");
	lines.push(renderTable(requestColumns(), session.requestPoints.map(requestRow)));
	return { stdout: `${lines.join("\n")}\n`, stderr: "", code: 0 };
}

function countList(counts: Record<string, number>): string {
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([key, count]) => `${key} ${count}`)
		.join(", ");
}

/** The facts behind the spec's open questions Q1 to Q5, printed so a real file answers them. */
export function openQuestionFacts(session: Session): string[] {
	const last = session.requestPoints[session.requestPoints.length - 1];
	const facts: string[] = [];
	if (last) {
		const state = replaySystemMessages(last.context.messages, last.context.sourceEntryIds);
		const sectionNames = [...state.sections.keys()];
		const projectContext = state.sections.get("project_context")?.text ?? "";
		const contextPaths = [...projectContext.matchAll(/<project_instructions path="([^"]+)"/g)].map((match) => match[1]);
		facts.push(`Q1 system sections at last request: ${sectionNames.join(", ") || "(none)"}; context files: ${contextPaths.join(", ") || "(none)"}`);
		facts.push(`Q1 tools declared at last request: ${[...state.tools.keys()].join(", ") || "(none)"}`);
	} else {
		facts.push("Q1 no request points");
	}
	const thinkingByProvider = new Map<string, { requests: number; chars: number }>();
	for (const rp of session.requestPoints) {
		if (rp.thinkingChars === 0) continue;
		const key = `${rp.provider}/${rp.model}`;
		const entry = thinkingByProvider.get(key) ?? { requests: 0, chars: 0 };
		entry.requests++;
		entry.chars += rp.thinkingChars;
		thinkingByProvider.set(key, entry);
	}
	facts.push(
		`Q2 thinking persisted: ${
			thinkingByProvider.size === 0
				? "none"
				: [...thinkingByProvider].map(([key, value]) => `${key} ${value.requests} requests, ${fmtInt(value.chars)} chars`).join("; ")
		}`,
	);
	facts.push(`Q3 header parentSession: ${session.parentSession ?? "(none)"}; file: ${session.path}`);
	facts.push(`Q4 session version ${session.version}${session.version < 3 ? " (migrated on load)" : ""}`);
	const skillReads = session.requestPoints.flatMap((rp) =>
		rp.toolCalls.filter((call) => call.path && /SKILL\.md$|\/skills\//.test(call.path)).map((call) => `${call.name} ${call.path} (turn ${rp.turnIndex})`),
	);
	const inlineSkills = session.turns.filter((turn) => /^<skill name="/.test(turn.userText)).map((turn) => `turn ${turn.index} /skill: in user message`);
	facts.push(`Q5 skill loads: ${[...skillReads, ...inlineSkills].join("; ") || "none"}`);
	const customTypes = new Map<string, number>();
	for (const entry of session.entries) {
		if (entry.type === "custom_message") customTypes.set(entry.customType, (customTypes.get(entry.customType) ?? 0) + 1);
	}
	facts.push(`custom_message types: ${[...customTypes].map(([type, count]) => `${type} ${count}`).join(", ") || "none"}`);
	return facts;
}

function requestColumns() {
	return [
		{ key: "index", label: "#", align: "right" as const },
		{ key: "turn", label: "turn", align: "right" as const },
		{ key: "model", label: "model", max: 24 },
		{ key: "think", label: "think" },
		{ key: "ctx", label: "ctx", align: "right" as const },
		{ key: "cache", label: "cache", align: "right" as const },
		{ key: "out", label: "out", align: "right" as const },
		{ key: "text", label: "text", align: "right" as const },
		{ key: "thinking", label: "thinking", align: "right" as const },
		{ key: "tools", label: "tools", align: "right" as const },
		{ key: "names", label: "tool names", max: 30 },
		{ key: "errors", label: "err", align: "right" as const },
		{ key: "stop", label: "stop" },
		{ key: "cost", label: "cost", align: "right" as const },
	];
}

function requestRow(rp: RequestPoint): Row {
	const names = new Map<string, number>();
	for (const call of rp.toolCalls) names.set(call.name, (names.get(call.name) ?? 0) + 1);
	return {
		index: rp.index,
		turn: rp.turnIndex,
		model: shortModel(rp.model),
		think: rp.thinkingLevel ?? "",
		ctx: fmtTokens(rp.usage.contextTokens),
		cache: fmtPct(cacheHitRatio(rp)),
		out: fmtTokens(rp.usage.output),
		text: fmtInt(rp.textChars),
		thinking: fmtInt(rp.thinkingChars),
		tools: rp.toolCalls.length,
		names: [...names].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join(" "),
		errors: rp.toolResults.filter((result) => result.isError).length,
		stop: rp.stopReason,
		cost: fmtCost(rp.usage.cost),
	};
}

export function cacheHitRatio(rp: RequestPoint): number {
	const total = rp.usage.input + rp.usage.cacheRead + rp.usage.cacheWrite;
	return total === 0 ? Number.NaN : rp.usage.cacheRead / total;
}

// ── sanitize ───────────────────────────────────────────────────────────────

function sanitize(file: string, options: CliOptions): CliResult {
	const out = options.out ?? file.replace(/\.jsonl$/, "") + ".sanitized.jsonl";
	if (out === file) throw new Error("refusing to overwrite the input; pass --out");
	writeFileSync(out, sanitizeJsonl(readFileSync(file, "utf8")));
	return { stdout: `${out}\n`, stderr: "", code: 0 };
}

// ── entry point ────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	const result = run(process.argv.slice(2));
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(`${result.stderr}${result.stderr.endsWith("\n") ? "" : "\n"}`);
	process.exitCode = result.code;
}
