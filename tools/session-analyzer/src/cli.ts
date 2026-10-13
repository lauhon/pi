/**
 * `npm run analyze -- <subcommand> [args]`
 *
 *   list <dir>...              one row per session file under the dirs (recursive)
 *   inspect <file>             one row per request point, plus the facts the spec's open questions ask for
 *   sanitize <file> [--out p]  write a same-size copy with every text body replaced (fixtures only)
 *   inventory <file> [--turn N | --request i]   what filled the window, by source
 *   inventory <dir>...         average share by source over every request under the dirs
 *   summary <file>             per-turn observables, findings and session totals
 *   summary <dir>...           the August audit's quantitative section, computed
 *   rank <dir>...              sessions by bad-signal score, for the labeling pass
 *   label <file>               the labeling worksheet: evidence, one block per turn, the record to fill
 *   labels <json> [<dir>...]   check reports/session-labels.json; with dirs, the unlabeled sessions
 *
 * Output is a terminal table by default, or JSON with --json.
 */
import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inventoryDirectory, inventoryRequestPoint, inventorySession, type RequestInventory, type SourceTotal } from "./inventory.ts";
import { ENDINGS, EXCERPT_CHARS, LEVELS, excerpt, labelEvidence, labelRecord, labelReport, labelTurns, parseLabels, turnFlags, type LabelEvidence, type LabelTurn } from "./labels.ts";
import { findSessionFiles, loadSession, replaySystemMessages } from "./load.ts";
import { directorySummary, formatFollowUps, sessionSummary, type ModelStats, type SessionSummary, type TurnObservables } from "./observables.ts";
import { rankSessions } from "./rank.ts";
import { fmtCost, fmtDate, fmtDuration, fmtInt, fmtPct, fmtTokens, renderTable, sessionJson, shortModel, toJson, type Row } from "./report.ts";
import { sanitizeJsonl } from "./sanitize.ts";
import type { RequestPoint, Session } from "./types.ts";
import { sliceSince } from "./window.ts";

const USAGE = `usage: npm run analyze -- <subcommand> [args] [--json]

  list <dir>...                sessions under the dirs (recursive), one row each
  inspect <file>               request points of one session
  sanitize <file> [--out path] same-size copy with text bodies replaced
  inventory <file> [--turn N | --request i]
                               what filled the window at that request (default: session totals and peak)
  inventory <dir>...           average share by source over every request
  summary <file>               per-turn observables, findings and session totals
  summary <dir>...             directory totals in the shape of the August audit
  rank <dir>...                sessions by bad-signal score, highest first
  label <file>                 the labeling worksheet for one session (step 4)
  labels <json> [<dir>...]     check the labels file; with dirs, list the unlabeled sessions by rank and cost

options: --json  --model <substring of the id; claude-opus-5-5 is claude-opus-5.5>
         --exclude <path substring>  --limit <n>
         --until <iso>  each session as it was at that time (the file truncated there)
         --since <iso>  only requests at or after that time
`;

export interface CliOptions {
	json: boolean;
	out?: string;
	turn?: number;
	request?: number;
	model?: string;
	since?: string;
	until?: string;
	exclude?: string;
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
				exclude: { type: "string" },
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
			exclude: parsed.values.exclude,
			limit: optionalInt(parsed.values.limit),
		};
		switch (command) {
			case "list":
				return list(requirePaths(positionals, "list <dir>..."), options);
			case "inspect":
				return inspect(requirePath(positionals[0], "inspect <file>"), options);
			case "sanitize":
				return sanitize(requirePath(positionals[0], "sanitize <file>"), options);
			case "inventory":
				return inventory(requirePaths(positionals, "inventory <file|dir>..."), options);
			case "summary":
				return summary(requirePaths(positionals, "summary <file|dir>..."), options);
			case "rank":
				return rank(requirePaths(positionals, "rank <dir>..."), options);
			case "label":
				return label(requirePath(positionals[0], "label <file>"), options);
			case "labels":
				return labels(
					requirePath(positionals[0], "labels <json> [<dir>...]"),
					positionals.slice(1).map((root) => requirePath(root, "labels <json> [<dir>...]")),
					options,
				);
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

/** Every session under the given roots (files or directories), windowed and filtered by the options. */
export function loadDirectories(roots: string[], options: CliOptions): { loaded: LoadedSession[]; warnings: string[] } {
	const loaded: LoadedSession[] = [];
	const warnings: string[] = [];
	for (const root of roots) {
		for (const file of findSessionFiles(root)) {
			try {
				const session = loadWindowed(file, options);
				if (session && keepSession(session, options)) loaded.push({ session, root });
			} catch (error) {
				warnings.push(`skipped ${file}: ${(error as Error).message}`);
			}
		}
	}
	return { loaded, warnings };
}

/** One session with --until and --since applied; null when a window leaves no request in it. */
export function loadWindowed(file: string, options: CliOptions): Session | null {
	let session: Session | null = loadSession(file, { until: options.until });
	if (options.since) session = sliceSince(session, options.since);
	if (session && (options.since || options.until) && session.requestPoints.length === 0) return null;
	return session;
}

function requireWindowed(file: string, options: CliOptions): Session {
	const session = loadWindowed(file, options);
	if (!session) throw new Error(`${file}: no requests inside the window`);
	return session;
}

export function displayPath(entry: LoadedSession): string {
	return statSync(entry.root).isFile() ? entry.root : relative(entry.root, entry.session.path);
}

function keepSession(session: Session, options: CliOptions): boolean {
	if (options.exclude && session.path.includes(options.exclude)) return false;
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
	const session = requireWindowed(file, options);
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

// ── inventory ──────────────────────────────────────────────────────────────

function inventory(roots: string[], options: CliOptions): CliResult {
	const single = roots.length === 1 && statSync(roots[0]).isFile();
	if (!single) return inventoryOfDirectory(roots, options);
	const session = requireWindowed(roots[0], options);
	if (options.turn !== undefined || options.request !== undefined) {
		const rp = selectRequest(session, options);
		const request = inventoryRequestPoint(rp, session);
		if (options.json) return { stdout: `${toJson(request)}\n`, stderr: "", code: 0 };
		const lines = [
			`request ${rp.index} (turn ${rp.turnIndex})  ${rp.provider}/${rp.model}  context ${fmtTokens(rp.usage.contextTokens)} tokens from usage, ${fmtInt(request.totalChars)} chars in ${request.segments.length} segments`,
			"",
			sourceTable(request.bySource),
			"",
			"largest segments:",
			renderTable(
				[
					{ key: "position", label: "pos", align: "right" },
					{ key: "source", label: "source" },
					{ key: "label", label: "label", max: 30 },
					{ key: "entryId", label: "entry" },
					{ key: "chars", label: "chars", align: "right" },
					{ key: "share", label: "share", align: "right" },
					{ key: "ageTurns", label: "age", align: "right" },
				],
				[...request.segments]
					.sort((a, b) => b.chars - a.chars)
					.slice(0, 15)
					.map((segment) => ({ ...segment, chars: fmtInt(segment.chars), share: fmtPct(request.totalChars > 0 ? segment.chars / request.totalChars : 0) })),
			),
		];
		return { stdout: `${lines.join("\n")}\n`, stderr: "", code: 0 };
	}
	const summary = inventorySession(session);
	if (options.json) return { stdout: `${toJson(summary)}\n`, stderr: "", code: 0 };
	const lines = [
		`session ${session.id}  ${summary.requestCount} requests  totals over every request, by source:`,
		"",
		sourceTable(summary.bySourceOnly, summary.meanShare),
		"",
		"largest labels (tool, customType, section, skill):",
		sourceTable(summary.bySource.filter((total) => total.label !== undefined).slice(0, options.limit ?? 15)),
		"",
		`skills loaded: ${summary.skillsLoaded.join(", ") || "none"}`,
		`injections: ${Object.entries(summary.injections).map(([type, chars]) => `${type} ${fmtInt(chars)} chars`).join(", ") || "none"}`,
	];
	if (summary.peak) {
		lines.push("", `peak: request ${summary.peak.requestIndex} (turn ${summary.peak.turnIndex})  context ${fmtTokens(summary.peak.contextTokens)} tokens, ${fmtInt(summary.peak.totalChars)} chars`, "", sourceTable(summary.peak.bySource));
	}
	return { stdout: `${lines.join("\n")}\n`, stderr: "", code: 0 };
}

function selectRequest(session: Session, options: CliOptions): RequestPoint {
	if (options.request !== undefined) {
		const rp = session.requestPoints[options.request];
		if (!rp) throw new Error(`no request ${options.request}; the session has ${session.requestPoints.length}`);
		return rp;
	}
	const turn = session.turns[options.turn ?? -1];
	if (!turn) throw new Error(`no turn ${options.turn}; the session has turns 1 to ${session.turns.length - 1}`);
	const last = turn.requestIndexes[turn.requestIndexes.length - 1];
	if (last === undefined) throw new Error(`turn ${options.turn} has no assistant request`);
	return session.requestPoints[last];
}

function sourceTable(totals: SourceTotal[], meanShare?: Partial<Record<string, number>>): string {
	const columns = [
		{ key: "source", label: "source" },
		{ key: "label", label: "label", max: 30 },
		{ key: "count", label: "n", align: "right" as const },
		{ key: "chars", label: "chars", align: "right" as const },
		{ key: "share", label: "share", align: "right" as const },
		...(meanShare ? [{ key: "meanShare", label: "mean share", align: "right" as const }] : []),
		{ key: "tokensEstimate", label: "~tokens", align: "right" as const },
		{ key: "position", label: "pos", align: "right" as const },
		{ key: "maxAgeTurns", label: "age", align: "right" as const },
	];
	return renderTable(
		columns,
		totals.map((total) => ({
			...total,
			chars: fmtInt(total.chars),
			share: fmtPct(total.share),
			...(meanShare ? { meanShare: fmtPct(meanShare[total.source] ?? 0) } : {}),
			tokensEstimate: fmtTokens(total.tokensEstimate),
		})),
	);
}

function inventoryOfDirectory(roots: string[], options: CliOptions): CliResult {
	const { loaded, warnings } = loadDirectories(roots, options);
	const summary = inventoryDirectory(loaded.map((entry) => entry.session));
	if (options.json) return { stdout: `${toJson(summary)}\n`, stderr: warnings.join("\n"), code: 0 };
	const rows: Row[] = (Object.keys(summary.meanShare) as (keyof typeof summary.meanShare)[])
		.sort((a, b) => (summary.meanShare[b] ?? 0) - (summary.meanShare[a] ?? 0))
		.map((source) => ({
			source,
			meanShare: fmtPct(summary.meanShare[source] ?? 0),
			p50: fmtPct(summary.distribution[source]?.p50 ?? 0),
			p90: fmtPct(summary.distribution[source]?.p90 ?? 0),
			max: fmtPct(summary.distribution[source]?.max ?? 0),
		}));
	const table = renderTable(
		[
			{ key: "source", label: "source" },
			{ key: "meanShare", label: "mean share", align: "right" },
			{ key: "p50", label: "p50", align: "right" },
			{ key: "p90", label: "p90", align: "right" },
			{ key: "max", label: "max", align: "right" },
		],
		rows,
	);
	const peaks = renderTable(
		[
			{ key: "path", label: "session", max: 70 },
			{ key: "requestIndex", label: "req", align: "right" },
			{ key: "contextTokens", label: "ctx", align: "right" },
			{ key: "totalChars", label: "chars", align: "right" },
		],
		summary.peaks.slice(0, options.limit ?? 10).map((peak) => ({ ...peak, contextTokens: fmtTokens(peak.contextTokens), totalChars: fmtInt(peak.totalChars) })),
	);
	const out = `${summary.sessionCount} sessions, ${fmtInt(summary.requestCount)} requests; share of context chars by source (mean of session means; p50/p90/max over requests)\n\n${table}\n\npeak context per session:\n${peaks}\n`;
	return { stdout: out, stderr: warnings.join("\n"), code: 0 };
}

// ── summary ────────────────────────────────────────────────────────────────

function summary(roots: string[], options: CliOptions): CliResult {
	const single = roots.length === 1 && statSync(roots[0]).isFile();
	if (!single) return summaryOfDirectory(roots, options);
	const session = requireWindowed(roots[0], options);
	const result = sessionSummary(session);
	if (options.json) return { stdout: `${toJson(result)}\n`, stderr: "", code: 0 };
	const lines = [
		`session ${result.id}  turns ${result.turns}  requests ${result.requests}  cost ${fmtCost(result.cost)}${result.otherCost > 0 ? ` (+${fmtCost(result.otherCost)} compaction/usage)` : ""}  peak context ${fmtTokens(result.peakContextTokens)}  duration ${fmtDuration(result.durationMs)}`,
		`compactions ${result.compactions}${result.compactions > 0 ? ` (tokens before: ${result.compactionTokensBefore.map(fmtTokens).join(", ")})` : ""}  forks ${result.forks}  branch summaries ${result.branchSummaries}  model changes ${result.modelChanges}  thinking changes ${result.thinkingChanges}`,
		`models: ${result.modelMix.map((row) => `${shortModel(row.model)} ${row.requests} req ${fmtCost(row.cost)}`).join("; ")}  top request ${fmtPct(result.topRequestCostShare)} of cost, top 5 ${fmtPct(result.top5RequestCostShare)}`,
		`tool calls ${result.toolCalls} (${countList(result.toolCallsByName)})  errors ${result.toolErrors}${result.toolErrors > 0 ? ` (${countList(result.toolErrorsByName)})` : ""}  missing path ${result.missingPathErrors}  failed commands ${result.failedCommands} (+${result.failedTestRuns} failing test runs)  immediate repeats ${result.immediateRepeats} of ${result.repeatedIdenticalCalls} identical`,
		`after an error: ${formatFollowUps(result.errorFollowUps)}; after a missing path: ${formatFollowUps(result.missingPathFollowUps)}`,
		`questions ${result.askedQuestions}  narration-only ${result.narrationOnlyTurns}  corrections ${result.correctionTurns}  rewinds ${result.rewinds}  errored ${result.errored}  interrupted ${result.interrupted}  tests run ${result.testsRun}  edit churn ${result.editChurn}  stale-read turns ${result.staleFileTurns}  rereads after compaction ${result.rereadAfterCompaction}  long responses ${result.longResponses} (>5k: ${result.veryLongResponses})  cache hit mean ${fmtPct(result.cacheHitRatioMean)}  drops ${result.cacheDrops}`,
		`injections: ${countList(result.injections) || "none"}`,
		"",
		renderTable(turnColumns(), result.turnObservables.map(turnRow)),
	];
	if (result.findings.length > 0) {
		lines.push("", "findings:");
		for (const finding of result.findings) lines.push(`  turn ${finding.turnIndex}  ${finding.severity.padEnd(4)}  ${finding.kind}: ${finding.message}`);
	}
	return { stdout: `${lines.join("\n")}\n`, stderr: "", code: 0 };
}

function turnColumns() {
	const right = "right" as const;
	return [
		{ key: "turn", label: "turn", align: right },
		{ key: "requests", label: "req", align: right },
		{ key: "userChars", label: "user", align: right },
		{ key: "toolCalls", label: "tools", align: right },
		{ key: "names", label: "tool names", max: 28 },
		{ key: "files", label: "r/e", align: right },
		{ key: "testsRun", label: "test", align: right },
		{ key: "toolErrors", label: "err", align: right },
		{ key: "errorRunMax", label: "run", align: right },
		{ key: "missingPathErrors", label: "miss", align: right },
		{ key: "immediateRepeats", label: "rep", align: right },
		{ key: "editChurn", label: "churn", align: right },
		{ key: "stale", label: "stale", align: right },
		{ key: "flags", label: "flags" },
		{ key: "finalTextChars", label: "text", align: right },
		{ key: "ctx", label: "ctx", align: right },
		{ key: "cache", label: "cache", align: right },
		{ key: "cost", label: "cost", align: right },
	];
}

function toolNames(byName: Record<string, number>): string {
	return Object.entries(byName)
		.map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
		.join(" ");
}

function turnRow(turn: TurnObservables): Row {
	return {
		turn: turn.turnIndex,
		requests: turn.requests,
		userChars: turn.userChars,
		toolCalls: turn.toolCalls,
		names: toolNames(turn.toolCallsByName),
		files: `${turn.filesRead.length}/${turn.filesEdited.length}`,
		testsRun: turn.testsRun,
		toolErrors: turn.toolErrors,
		errorRunMax: turn.errorRunMax,
		missingPathErrors: turn.missingPathErrors,
		immediateRepeats: turn.immediateRepeats,
		editChurn: turn.editChurn,
		stale: turn.staleFilesInContext.length,
		flags: turnFlags(turn).join(" "),
		finalTextChars: turn.finalTextChars,
		ctx: fmtTokens(turn.peakContextTokens),
		cache: fmtPct(turn.cacheHitRatioMin),
		cost: fmtCost(turn.cost),
	};
}

export function loadSummaries(roots: string[], options: CliOptions): { summaries: SessionSummary[]; warnings: string[]; byRoot: Map<string, number> } {
	const { loaded, warnings } = loadDirectories(roots, options);
	const byRoot = new Map<string, number>();
	for (const entry of loaded) byRoot.set(entry.root, (byRoot.get(entry.root) ?? 0) + 1);
	return { summaries: loaded.map((entry) => sessionSummary(entry.session)), warnings, byRoot };
}

function summaryOfDirectory(roots: string[], options: CliOptions): CliResult {
	const { summaries, warnings, byRoot } = loadSummaries(roots, options);
	const result = directorySummary(summaries);
	if (options.json) {
		const { sessionsBySize, ...rest } = result;
		return { stdout: `${toJson({ ...rest, byRoot, sessionsBySize: sessionsBySize.slice(0, options.limit ?? 10) })}\n`, stderr: warnings.join("\n"), code: 0 };
	}
	const mix = renderTable(
		[
			{ key: "model", label: "model" },
			{ key: "requests", label: "requests", align: "right" },
			{ key: "cost", label: "cost", align: "right" },
			{ key: "requestShare", label: "share of requests", align: "right" },
			{ key: "costShare", label: "share of cost", align: "right" },
		],
		result.modelMix.map((row) => ({ ...row, requests: fmtInt(row.requests), cost: fmtCost(row.cost), requestShare: fmtPct(row.requestShare), costShare: fmtPct(row.costShare) })),
	);
	const top = renderTable(
		[
			{ key: "path", label: "session", max: 70 },
			{ key: "cost", label: "cost", align: "right" },
			{ key: "requests", label: "req", align: "right" },
			{ key: "peakContextTokens", label: "peak ctx", align: "right" },
		],
		result.sessionsBySize.slice(0, options.limit ?? 10).map((row) => ({ ...row, cost: fmtCost(row.cost), peakContextTokens: fmtTokens(row.peakContextTokens) })),
	);
	const lines = [
		`${result.sessions} sessions (${[...byRoot].map(([root, count]) => `${root}: ${count}`).join(", ")}), ${fmtInt(result.requests)} assistant requests, recorded cost ${fmtCost(result.cost)}${result.otherCost > 0 ? ` (+${fmtCost(result.otherCost)} compaction/usage entries)` : ""}`,
		`cost concentration: most expensive session ${fmtPct(result.topSessionCostShare)}, five most expensive ${fmtPct(result.top5SessionCostShare)}`,
		"",
		mix,
		"",
		`tool errors ${fmtInt(result.toolErrors)}${result.toolErrors > 0 ? ` (${countList(result.toolErrorsByName)})` : ""}: ${result.missingPathErrors} missing-path, ${result.failedCommands} failed commands (+${result.failedTestRuns} failing test runs), ${result.immediateRepeats} immediate identical repeats (${result.repeatedIdenticalCalls} identical calls in all)`,
		`after an error, the next request was: ${formatFollowUps(result.errorFollowUps)}`,
		`after a missing-path error: ${formatFollowUps(result.missingPathFollowUps)}`,
		`compactions ${result.compactions}; largest request context ${fmtTokens(result.peakContextTokens)} tokens`,
		`responses over 2,000 chars: ${result.longResponses}; over 5,000: ${result.veryLongResponses}`,
		`corrections ${result.correctionTurns}, rewinds ${result.rewinds}, errored ${result.errored}, interrupted ${result.interrupted}, questions ${result.askedQuestions}, narration-only turns ${result.narrationOnlyTurns}, test runs ${result.testsRun}`,
		"",
		"per model, per 100 requests (guess = same tool on another path after a missing-path error; enumerate = another tool):",
		modelTable(result.byModel.slice(0, options.limit ?? 10)),
		"",
		"most expensive sessions:",
		top,
	];
	return { stdout: `${lines.join("\n")}\n`, stderr: warnings.join("\n"), code: 0 };
}

function modelTable(rows: ModelStats[]): string {
	const right = "right" as const;
	const per100 = (value: number, requests: number) => (requests > 0 ? ((value / requests) * 100).toFixed(1) : "-");
	return renderTable(
		[
			{ key: "model", label: "model" },
			{ key: "requests", label: "requests", align: right },
			{ key: "cost", label: "cost", align: right },
			{ key: "errors", label: "errors", align: right },
			{ key: "missing", label: "missing path", align: right },
			{ key: "guess", label: "guess", align: right },
			{ key: "enumerate", label: "enumerate", align: right },
			{ key: "stop", label: "stop", align: right },
			{ key: "failed", label: "failed cmd", align: right },
			{ key: "tests", label: "test fails", align: right },
			{ key: "errored", label: "errored", align: right },
			{ key: "interrupted", label: "interrupted", align: right },
			{ key: "long", label: "long", align: right },
		],
		rows.map((row) => ({
			model: row.model,
			requests: fmtInt(row.requests),
			cost: fmtCost(row.cost),
			errors: per100(row.toolErrors, row.requests),
			missing: per100(row.missingPathErrors, row.requests),
			guess: `${row.missingPathFollowUps.otherTarget + row.missingPathFollowUps.identical}/${row.missingPathErrors}`,
			enumerate: `${row.missingPathFollowUps.otherTool}/${row.missingPathErrors}`,
			stop: `${row.missingPathFollowUps.none}/${row.missingPathErrors}`,
			failed: per100(row.failedCommands, row.requests),
			tests: per100(row.failedTestRuns, row.requests),
			errored: per100(row.errored, row.requests),
			interrupted: per100(row.interrupted, row.requests),
			long: per100(row.longResponses, row.requests),
		})),
	);
}

// ── rank ───────────────────────────────────────────────────────────────────

function rank(roots: string[], options: CliOptions): CliResult {
	const { summaries, warnings } = loadSummaries(roots, options);
	const ranked = rankSessions(summaries).slice(0, options.limit ?? 50);
	if (options.json) {
		return {
			stdout: `${toJson(ranked.map(({ summary: s, ...rest }) => ({ ...rest, cost: s.cost, requests: s.requests, turns: s.turns, peakContextTokens: s.peakContextTokens, startedAt: s.startedAt })))}\n`,
			stderr: warnings.join("\n"),
			code: 0,
		};
	}
	const table = renderTable(
		[
			{ key: "score", label: "score", align: "right" },
			{ key: "corr", label: "corr", align: "right" },
			{ key: "rew", label: "rew", align: "right" },
			{ key: "err", label: "errrun", align: "right" },
			{ key: "rep", label: "repeat", align: "right" },
			{ key: "abort", label: "abort", align: "right" },
			{ key: "ctx", label: "ctx", align: "right" },
			{ key: "cost", label: "cost", align: "right" },
			{ key: "requests", label: "req", align: "right" },
			{ key: "path", label: "session", max: 80 },
		],
		ranked.map((row) => ({
			score: row.score.toFixed(2),
			corr: row.components.correctionTurns.toFixed(2),
			rew: row.components.rewinds.toFixed(2),
			err: row.components.errorRuns.toFixed(2),
			rep: row.components.repeatedIdenticalCalls.toFixed(2),
			abort: row.components.aborted.toFixed(2),
			ctx: row.components.largeContext.toFixed(2),
			cost: fmtCost(row.summary.cost),
			requests: row.summary.requests,
			path: row.path,
		})),
	);
	return {
		stdout: `${table}\n${ranked.length} sessions ranked; a component is the session's rate per 100 requests over the directory's 90th percentile, clipped to 1; ctx is peak context above 200k per 100k (see rank.ts)\n`,
		stderr: warnings.join("\n"),
		code: 0,
	};
}

// ── label ──────────────────────────────────────────────────────────────────

interface NextSession {
	path: string;
	startedAt: string;
	gapMs: number;
	turns: number;
	requests: number;
	cost: number;
	firstUser: string;
}

/**
 * The session that followed this one in the same directory, by pi's timestamped file name
 * (`<timestamp>_<id>.jsonl`): a follow-up that fixes this one is outcome evidence. Sub-run
 * files are all called session.jsonl and have no next.
 */
function nextSessionInDirectory(file: string, session: Session): NextSession | undefined {
	const dir = dirname(file);
	const name = basename(file);
	if (!/^\d/.test(name)) return undefined;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	const next = names.filter((candidate) => candidate.endsWith(".jsonl") && /^\d/.test(candidate) && candidate > name).sort()[0];
	if (!next) return undefined;
	const path = join(dir, next);
	try {
		const sibling = loadSession(path);
		const firstTurn = sibling.turns.find((turn) => turn.userEntryId !== undefined);
		return {
			path,
			startedAt: sibling.startedAt,
			gapMs: Date.parse(sibling.startedAt) - Date.parse(session.endedAt),
			turns: sibling.turns.length - 1,
			requests: sibling.requestPoints.length,
			cost: sessionCost(sibling),
			firstUser: excerpt(firstTurn?.userText ?? "", EXCERPT_CHARS.user),
		};
	} catch {
		return undefined;
	}
}

function label(file: string, options: CliOptions): CliResult {
	const session = requireWindowed(file, options);
	const result = sessionSummary(session);
	const evidence = labelEvidence(session, result.turnObservables);
	const turns = labelTurns(session, result.turnObservables);
	const next = nextSessionInDirectory(file, session);
	const record = labelRecord(file);
	if (options.json) {
		const header = {
			path: result.path,
			id: result.id,
			cwd: result.cwd,
			...(session.parentSession ? { parentSession: session.parentSession } : {}),
			startedAt: result.startedAt,
			durationMs: result.durationMs,
			turns: result.turns,
			requests: result.requests,
			cost: result.cost,
			peakContextTokens: result.peakContextTokens,
			compactions: result.compactions,
			rewinds: result.rewinds,
			modelMix: result.modelMix,
		};
		return { stdout: `${toJson({ session: header, evidence, next: next ?? null, turns, findings: result.findings, record })}\n`, stderr: "", code: 0 };
	}
	const lines = [
		`session ${session.id}  ${file}${session.parentSession ? `  parent ${session.parentSession}` : ""}`,
		`cwd ${session.cwd}  started ${fmtDate(session.startedAt)}  duration ${fmtDuration(session.durationMs)}  turns ${result.turns}  requests ${result.requests}  cost ${fmtCost(result.cost)}  peak context ${fmtTokens(result.peakContextTokens)}  compactions ${result.compactions}  models ${result.modelMix.map((row) => `${shortModel(row.model)} ${row.requests}`).join(", ")}`,
		`evidence: ${evidenceLine(evidence)}`,
		next
			? `next session in this directory: ${basename(next.path)}, ${fmtDuration(Math.max(0, next.gapMs))} after this one ended, ${next.turns} turns, ${fmtCost(next.cost)}: "${next.firstUser}"`
			: "next session in this directory: none",
		"",
	];
	for (const turn of turns) lines.push(...turnBlock(turn));
	if (result.findings.length > 0) {
		lines.push("findings:");
		for (const finding of result.findings) lines.push(`  turn ${finding.turnIndex}  ${finding.severity.padEnd(4)}  ${finding.kind}: ${finding.message}`);
		lines.push("");
	}
	lines.push(`record (outcome good, bad or mixed; level ${LEVELS.join(", ")}):`, JSON.stringify(record));
	return { stdout: `${lines.join("\n")}\n`, stderr: "", code: 0 };
}

function evidenceLine(evidence: LabelEvidence): string {
	const at = (turns: number[]) => `turn${turns.length > 1 ? "s" : ""} ${turns.join(", ")}`;
	return [
		evidence.rewindTurns.length > 0 ? `rewinds at ${at(evidence.rewindTurns)}` : "no rewinds",
		evidence.correctionTurns.length > 0 ? `corrections at ${at(evidence.correctionTurns)}` : "no corrections",
		evidence.interruptedTurns.length > 0 ? `interrupted at ${at(evidence.interruptedTurns)}` : "",
		evidence.erroredTurns.length > 0 ? `provider errors at ${at(evidence.erroredTurns)}` : "",
		evidence.errorRunTurns.length > 0 ? `error runs at ${at(evidence.errorRunTurns)}` : "",
		evidence.questionTurns.length > 0 ? `questions at ${at(evidence.questionTurns)}` : "",
		`ended at turn ${evidence.lastTurn}: ${ENDINGS[evidence.ending]}`,
		evidence.costliestTurns.length > 0
			? `costliest ${at(evidence.costliestTurns.map((turn) => turn.turnIndex))} (${evidence.costliestTurns.map((turn) => fmtCost(turn.cost)).join(", ")})`
			: "",
	]
		.filter(Boolean)
		.join("; ");
}

function turnBlock(turn: LabelTurn): string[] {
	const head = [
		`turn ${turn.turnIndex}`,
		`+${fmtDuration(turn.offsetMs)}`,
		`req ${turn.requests}`,
		fmtCost(turn.cost),
		`tools ${turn.toolCalls}${turn.toolCalls > 0 ? `: ${toolNames(turn.toolCallsByName)}` : ""}`,
		turn.toolErrors > 0 ? `err ${turn.toolErrors}${turn.missingPathErrors > 0 ? ` (missing path ${turn.missingPathErrors})` : ""}` : "",
		turn.flags.length > 0 ? `flags ${turn.flags.join(" ")}` : "",
	].filter(Boolean);
	return [head.join("  "), `  user  ${turn.user || "(empty)"}`, `  final ${turn.final || "(no text)"}`, ""];
}

// ── labels ─────────────────────────────────────────────────────────────────

function labels(file: string, roots: string[], options: CliOptions): CliResult {
	const parsed = parseLabels(readFileSync(file, "utf8"));
	const warnings: string[] = [];
	let summaries: SessionSummary[] | undefined;
	if (roots.length > 0) {
		const loaded = loadSummaries(roots, options);
		summaries = loaded.summaries;
		warnings.push(...loaded.warnings);
	}
	const byPath = new Map((summaries ?? []).map((summary) => [resolve(summary.path), summary]));
	const lastTurnOf = summaries
		? (session: string) => {
				const summary = byPath.get(resolve(session));
				if (!summary) return undefined;
				const last = summary.turnObservables[summary.turnObservables.length - 1];
				return last ? last.turnIndex : 0;
			}
		: undefined;
	const report = labelReport(parsed, lastTurnOf);
	const labeled = new Set(parsed.labels.map((label) => resolve(label.session)));
	const unlabeled = (summaries ?? []).filter((summary) => !labeled.has(resolve(summary.path)));
	const limit = options.limit ?? 10;
	const byRank = summaries ? rankSessions(summaries).filter((row) => !labeled.has(resolve(row.path))).slice(0, limit) : [];
	const byCost = [...unlabeled].sort((a, b) => b.cost - a.cost || a.path.localeCompare(b.path)).slice(0, limit);
	const code = report.problems.length > 0 ? 1 : 0;
	if (options.json) {
		const lists = summaries
			? {
					sessions: summaries.length,
					unlabeled: unlabeled.length,
					byRank: byRank.map((row) => ({ path: row.path, score: row.score, cost: row.summary.cost, requests: row.summary.requests })),
					byCost: byCost.map((summary) => ({ path: summary.path, cost: summary.cost, requests: summary.requests, peakContextTokens: summary.peakContextTokens })),
				}
			: {};
		return { stdout: `${toJson({ file, report, labels: parsed.labels, ...lists })}\n`, stderr: warnings.join("\n"), code };
	}
	const lines = [
		`${file}: ${report.count} labels (good ${report.byOutcome.good}, bad ${report.byOutcome.bad}, mixed ${report.byOutcome.mixed}), ${report.problems.length} problems`,
		`step 4 done when at least ${report.target} are labeled and every bad one has earliestSaveTurn and level: ${
			report.done ? "met" : `not met (${report.count} of ${report.target}${report.incomplete.length > 0 ? `; incomplete: ${report.incomplete.join(", ")}` : ""})`
		}`,
	];
	if (report.problems.length > 0) {
		lines.push("problems:");
		for (const problem of report.problems) lines.push(`  ${problem}`);
	}
	if (report.clusters.length > 0) {
		lines.push(
			"",
			renderTable(
				[
					{ key: "level", label: "level" },
					{ key: "total", label: "total", align: "right" },
					{ key: "bad", label: "bad", align: "right" },
					{ key: "mixed", label: "mixed", align: "right" },
					{ key: "good", label: "good", align: "right" },
				],
				report.clusters.map((cluster) => ({ ...cluster })),
			),
		);
	}
	if (summaries) {
		lines.push("", `${summaries.length} sessions under the given directories: ${summaries.length - unlabeled.length} labeled, ${unlabeled.length} not`);
		if (byRank.length > 0) {
			lines.push(
				"",
				"unlabeled, by rank:",
				renderTable(
					[
						{ key: "score", label: "score", align: "right" },
						{ key: "cost", label: "cost", align: "right" },
						{ key: "requests", label: "req", align: "right" },
						{ key: "path", label: "session", max: 90 },
					],
					byRank.map((row) => ({ score: row.score.toFixed(2), cost: fmtCost(row.summary.cost), requests: row.summary.requests, path: row.path })),
				),
			);
		}
		if (byCost.length > 0) {
			lines.push(
				"",
				"unlabeled, by cost:",
				renderTable(
					[
						{ key: "cost", label: "cost", align: "right" },
						{ key: "requests", label: "req", align: "right" },
						{ key: "peakContextTokens", label: "peak ctx", align: "right" },
						{ key: "path", label: "session", max: 90 },
					],
					byCost.map((summary) => ({ cost: fmtCost(summary.cost), requests: summary.requests, peakContextTokens: fmtTokens(summary.peakContextTokens), path: summary.path })),
				),
			);
		}
	}
	return { stdout: `${lines.join("\n")}\n`, stderr: warnings.join("\n"), code };
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
