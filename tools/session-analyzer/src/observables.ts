/**
 * Structural observables (spec, "Observables (step 3)"): what the agent did per turn, as
 * counts, plus the session and directory summaries. No model calls. Pure functions over the
 * plain data from load.ts.
 *
 * A turn is the span from one user message to the next on the active branch (load.ts). Every
 * cue list and pattern table lives in one place here, as the spec asks.
 */
import type { RequestPoint, Session, ToolCallRecord, ToolResultRecord, Turn } from "./types.ts";
import { turnBeforeWindow } from "./window.ts";

// ── Tables ─────────────────────────────────────────────────────────────────

/** Bash commands that run a test suite. Matched as a word anywhere in the command. */
export const TEST_RUNNERS: RegExp[] = [
	/\bvitest\b/,
	/\bjest\b/,
	/\bpytest\b/,
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
	/\bgo\s+test\b/,
	/\bcargo\s+test\b/,
];

/** Error texts that mean the path the tool was given does not exist or is the wrong kind. */
export const MISSING_PATH_PATTERNS: RegExp[] = [
	/ENOENT/,
	/no such file or directory/i,
	/EISDIR/,
	/is a directory/i,
	/ENOTDIR/,
	/not a directory/i,
	/cannot access '/,
	/Working directory does not exist/,
	/Offset \d+ is beyond end of file/,
];

/** Opening words of a user message that corrects the previous assistant turn. */
export const CORRECTION_CUES: RegExp[] = [
	/^no\b/i,
	/^nope\b/i,
	/^not\b/i,
	/^don'?t\b/i,
	/^do not\b/i,
	/^stop\b/i,
	/^wait\b/i,
	/^actually\b/i,
	/^i meant\b/i,
	/^i didn'?t\b/i,
	/^that'?s not\b/i,
	/^that is not\b/i,
	/^wrong\b/i,
	/^undo\b/i,
	/^revert\b/i,
	/^instead\b/i,
	/^why did you\b/i,
	/^you (?:didn'?t|did not|should|shouldn'?t)\b/i,
];

export const THRESHOLDS = {
	/** A correction is a short user message (chars) after a long assistant turn. */
	correctionMaxChars: 300,
	/** An assistant turn is long when it has at least this many tool calls ... */
	longTurnMinToolCalls: 3,
	/** ... or at least this many visible characters. */
	longTurnMinTextChars: 1000,
	longResponseChars: 2000,
	veryLongResponseChars: 5000,
	/** A cache hit ratio drop between adjacent requests, in points, that is flagged. */
	cacheDropPoints: 50,
	/** Context size above which a request counts as large (audit: contexts up to 314k). */
	largeContextTokens: 200_000,
	/** Consecutive tool errors that make an error run worth a finding. */
	errorRunWarn: 3,
} as const;

export const READ_TOOLS = new Set(["read"]);
export const EDIT_TOOLS = new Set(["edit", "write"]);
export const SHELL_TOOLS = new Set(["bash", "powershell"]);

// ── Per turn ───────────────────────────────────────────────────────────────

export interface TurnObservables {
	turnIndex: number;
	userEntryId?: string;
	userChars: number;
	requests: number;
	/** Sum of the turn's assistant output tokens and cost. */
	outputTokens: number;
	cost: number;
	/** Largest context of the turn's requests, in tokens. */
	peakContextTokens: number;
	askedQuestion: boolean;
	narrationOnly: boolean;
	toolCalls: number;
	toolCallsByName: Record<string, number>;
	filesRead: string[];
	filesEdited: string[];
	editChurn: number;
	testsRun: number;
	toolErrors: number;
	toolErrorsByName: Record<string, number>;
	/** Longest run of consecutive error results within the turn. */
	errorRunMax: number;
	/** Error results whose text equals an earlier error text in the session. */
	repeatedErrorText: number;
	missingPathErrors: number;
	/** Calls with the same tool and argsHash as an earlier call in the session. */
	repeatedIdenticalCalls: number;
	/** Of those, calls whose previous tool call in the same turn was the identical one. */
	immediateRepeats: number;
	/** What the agent did in the next request after each tool error (see ErrorFollowUp). */
	errorFollowUps: Record<ErrorFollowUp, number>;
	rereadAfterCompaction: number;
	/** Distinct paths whose read result is still in the final request's context after a later edit. */
	staleFilesInContext: string[];
	textBeforeFirstTool: number;
	/** Visible text of the turn's final assistant message. */
	finalTextChars: number;
	longResponses: number;
	veryLongResponses: number;
	correctionTurn: boolean;
	/** Abandoned branches forking from an entry of this turn. */
	rewinds: number;
	/** Branch summaries appended in this turn (a rewind that kept a summary of the abandoned path). */
	branchSummaries: number;
	aborted: number;
	cacheHitRatioMin: number;
	cacheDrops: number;
	modelChanges: number;
	thinkingChanges: number;
	injections: Record<string, number>;
	models: string[];
}

export interface Finding {
	kind: string;
	severity: "info" | "warn";
	turnIndex: number;
	/** Entry ids. */
	evidence: string[];
	message: string;
}

/**
 * The next request's answer to a tool error, in the same turn:
 * - identical: the same tool with the same arguments (a blind retry)
 * - sameTarget: the same tool on the same path with changed arguments (an edit variant, a read with an offset)
 * - otherTarget: the same tool on another path or command (the path guessing of audit finding 3)
 * - otherTool: a different tool (ls after ENOENT, a recovery)
 * - none: no tool call followed in the turn (the agent stopped or asked)
 */
export type ErrorFollowUp = "identical" | "sameTarget" | "otherTarget" | "otherTool" | "none";

export const ERROR_FOLLOW_UPS: ErrorFollowUp[] = ["identical", "sameTarget", "otherTarget", "otherTool", "none"];

export function emptyFollowUps(): Record<ErrorFollowUp, number> {
	return { identical: 0, sameTarget: 0, otherTarget: 0, otherTool: 0, none: 0 };
}

/** Classify the calls of the request after a failed call. The closest match among them wins. */
export function classifyFollowUp(failed: ToolCallRecord, nextCalls: ToolCallRecord[]): ErrorFollowUp {
	if (nextCalls.length === 0) return "none";
	let best: ErrorFollowUp = "otherTool";
	for (const call of nextCalls) {
		if (call.name !== failed.name) continue;
		if (call.argsHash === failed.argsHash) return "identical";
		if (failed.path !== undefined && call.path === failed.path) best = "sameTarget";
		else if (best !== "sameTarget") best = "otherTarget";
	}
	return best;
}

interface SessionCallState {
	seenHashes: Map<string, string>;
	previousCall?: { key: string; entryId: string };
	seenErrorTexts: Set<string>;
	readBeforeCompaction: Set<string>;
	readAfterCompaction: Set<string>;
	compactionSeen: boolean;
	lastWriteByPath: Map<string, number>;
}

function callKey(call: ToolCallRecord): string {
	return `${call.name}\u0000${call.argsHash}`;
}

export function isMissingPathError(text: string): boolean {
	return MISSING_PATH_PATTERNS.some((pattern) => pattern.test(text));
}

export function isTestCommand(command: string): boolean {
	return TEST_RUNNERS.some((pattern) => pattern.test(command));
}

export function isCorrectionText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 0 && trimmed.length <= THRESHOLDS.correctionMaxChars && CORRECTION_CUES.some((cue) => cue.test(trimmed));
}

export function endsWithQuestion(text: string): boolean {
	const trimmed = text.trim().replace(/[*_`)\]"']+$/, "").trimEnd();
	return trimmed.endsWith("?");
}

function normalizeError(text: string): string {
	return text.trim().replace(/\s+/g, " ").slice(0, 500);
}

/** Observables for every turn of a session, in order, including turn 0 only when it has requests. */
export function turnObservables(session: Session): TurnObservables[] {
	const state: SessionCallState = {
		seenHashes: new Map(),
		seenErrorTexts: new Set(),
		readBeforeCompaction: new Set(),
		readAfterCompaction: new Set(),
		compactionSeen: false,
		lastWriteByPath: new Map(),
	};
	const branchIndex = new Map<string, number>();
	session.branch.forEach((entry, i) => branchIndex.set(entry.id, i));
	const rewindsByTurn = new Map<number, number>();
	for (const fork of session.forks) rewindsByTurn.set(fork.turnIndex, (rewindsByTurn.get(fork.turnIndex) ?? 0) + fork.abandoned.length);
	const compactionTurns = new Set(session.compactions.map((compaction) => compaction.turnIndex));
	const results: TurnObservables[] = [];
	let previous: TurnObservables | undefined;
	let previousRatio: number | undefined;
	const readPositions = new Map<string, number[]>();
	for (const turn of session.turns) {
		if (turn.index === 0 && turn.requestIndexes.length === 0) continue;
		if (turnBeforeWindow(session, turn.index)) continue;
		const requests = turn.requestIndexes.map((index) => session.requestPoints[index]);
		// A repeat is "immediate" only without a user message in between: a user asking for the
		// same call again is not a blind retry.
		state.previousCall = undefined;
		const observed = observeTurn(session, turn, requests, state, branchIndex, readPositions, previousRatio);
		observed.rewinds = rewindsByTurn.get(turn.index) ?? 0;
		observed.branchSummaries = countEntriesInTurn(session, turn.index, "branch_summary");
		observed.modelChanges = countEntriesInTurn(session, turn.index, "model_change");
		observed.thinkingChanges = countEntriesInTurn(session, turn.index, "thinking_level_change");
		observed.correctionTurn = previous !== undefined && isLongTurn(previous) && isCorrectionText(turn.userText);
		if (compactionTurns.has(turn.index)) {
			state.compactionSeen = true;
			for (const path of state.readAfterCompaction) state.readBeforeCompaction.add(path);
			state.readAfterCompaction.clear();
		}
		results.push(observed);
		previous = observed;
		if (requests.length > 0) previousRatio = cacheHitRatio(requests[requests.length - 1]);
	}
	return results;
}

function countEntriesInTurn(session: Session, turnIndex: number, type: string): number {
	let count = 0;
	for (const entry of session.branch) {
		if (entry.type === type && session.turnOf.get(entry.id) === turnIndex) count++;
	}
	return count;
}

export function isLongTurn(turn: TurnObservables): boolean {
	return turn.toolCalls >= THRESHOLDS.longTurnMinToolCalls || turn.finalTextChars >= THRESHOLDS.longTurnMinTextChars || turn.longResponses > 0;
}

export function cacheHitRatio(rp: RequestPoint): number {
	const total = rp.usage.input + rp.usage.cacheRead + rp.usage.cacheWrite;
	return total === 0 ? Number.NaN : rp.usage.cacheRead / total;
}

function observeTurn(
	session: Session,
	turn: Turn,
	requests: RequestPoint[],
	state: SessionCallState,
	branchIndex: Map<string, number>,
	readPositions: Map<string, number[]>,
	previousRatio: number | undefined,
): TurnObservables {
	const toolCallsByName: Record<string, number> = {};
	const toolErrorsByName: Record<string, number> = {};
	const filesRead = new Set<string>();
	const filesEdited = new Set<string>();
	const editsByPath = new Map<string, { oldText?: string; newText?: string }[]>();
	let toolCalls = 0;
	let editChurn = 0;
	let testsRun = 0;
	let toolErrors = 0;
	let errorRun = 0;
	let errorRunMax = 0;
	let repeatedErrorText = 0;
	let missingPathErrors = 0;
	let repeatedIdenticalCalls = 0;
	let immediateRepeats = 0;
	const errorFollowUps = emptyFollowUps();
	let rereadAfterCompaction = 0;
	let textBeforeFirstTool = 0;
	let sawToolCall = false;
	let longResponses = 0;
	let veryLongResponses = 0;
	let aborted = 0;
	let cacheDrops = 0;
	let cacheHitRatioMin = Number.POSITIVE_INFINITY;
	let lastRatio = previousRatio;
	const injections: Record<string, number> = {};
	const models = new Set<string>();

	for (const rp of requests) {
		models.add(rp.model);
		if (rp.stopReason === "aborted" || rp.stopReason === "error") aborted++;
		if (rp.textChars > THRESHOLDS.longResponseChars) longResponses++;
		if (rp.textChars > THRESHOLDS.veryLongResponseChars) veryLongResponses++;
		if (!sawToolCall) {
			textBeforeFirstTool += textBeforeFirstCall(session, rp);
			if (rp.toolCalls.length > 0) sawToolCall = true;
		}
		const ratio = cacheHitRatio(rp);
		if (!Number.isNaN(ratio)) {
			cacheHitRatioMin = Math.min(cacheHitRatioMin, ratio);
			if (lastRatio !== undefined && !Number.isNaN(lastRatio) && (lastRatio - ratio) * 100 >= THRESHOLDS.cacheDropPoints) cacheDrops++;
			lastRatio = ratio;
		}
		const resultById = new Map<string, ToolResultRecord>();
		for (const result of rp.toolResults) resultById.set(result.id, result);
		const assistantPosition = branchIndex.get(rp.assistantEntryId) ?? 0;
		for (const call of rp.toolCalls) {
			toolCalls++;
			toolCallsByName[call.name] = (toolCallsByName[call.name] ?? 0) + 1;
			const key = callKey(call);
			if (state.seenHashes.has(key)) {
				repeatedIdenticalCalls++;
				if (state.previousCall?.key === key) immediateRepeats++;
			} else {
				state.seenHashes.set(key, rp.assistantEntryId);
			}
			state.previousCall = { key, entryId: rp.assistantEntryId };
			if (READ_TOOLS.has(call.name) && call.path) {
				filesRead.add(call.path);
				if (state.compactionSeen && state.readBeforeCompaction.has(call.path)) rereadAfterCompaction++;
				(state.compactionSeen ? state.readAfterCompaction : state.readBeforeCompaction).add(call.path);
				const result = resultById.get(call.id);
				if (result && !result.isError) {
					const positions = readPositions.get(call.path) ?? [];
					positions.push(branchIndex.get(result.entryId) ?? assistantPosition);
					readPositions.set(call.path, positions);
				}
			}
			if (EDIT_TOOLS.has(call.name) && call.path) {
				filesEdited.add(call.path);
				const result = resultById.get(call.id);
				if (!result || !result.isError) state.lastWriteByPath.set(call.path, assistantPosition);
				const edits = editsByPath.get(call.path) ?? [];
				const edit = { oldText: stringArg(call.args.oldText), newText: stringArg(call.args.newText) };
				if (edits.length > 0) editChurn++;
				if (edits.some((earlier) => earlier.oldText !== undefined && earlier.oldText === edit.newText && earlier.newText === edit.oldText)) editChurn++;
				edits.push(edit);
				editsByPath.set(call.path, edits);
			}
			if (SHELL_TOOLS.has(call.name)) {
				const command = stringArg(call.args.command) ?? "";
				if (isTestCommand(command)) testsRun++;
			}
		}
		for (const result of rp.toolResults) {
			if (!result.isError) {
				errorRun = 0;
				continue;
			}
			toolErrors++;
			toolErrorsByName[result.name] = (toolErrorsByName[result.name] ?? 0) + 1;
			errorRun++;
			errorRunMax = Math.max(errorRunMax, errorRun);
			if (isMissingPathError(result.text)) missingPathErrors++;
			const normalized = normalizeError(result.text);
			if (state.seenErrorTexts.has(normalized)) repeatedErrorText++;
			else state.seenErrorTexts.add(normalized);
		}
	}
	requests.forEach((rp, i) => {
		const nextCalls = requests[i + 1]?.toolCalls ?? [];
		const callById = new Map(rp.toolCalls.map((call) => [call.id, call]));
		for (const result of rp.toolResults) {
			if (!result.isError) continue;
			const failed = callById.get(result.id);
			if (failed) errorFollowUps[classifyFollowUp(failed, nextCalls)]++;
		}
	});
	for (const entry of session.branch) {
		if (entry.type === "custom_message" && session.turnOf.get(entry.id) === turn.index) {
			const chars = typeof entry.content === "string" ? entry.content.length : JSON.stringify(entry.content).length;
			injections[entry.customType] = (injections[entry.customType] ?? 0) + chars;
		}
	}
	const last = requests[requests.length - 1];
	const finalText = last ? assistantTextOf(session, last) : "";
	const askedQuestion = last !== undefined && last.toolCalls.length === 0 && last.stopReason !== "toolUse" && endsWithQuestion(finalText);
	const narrationOnly = requests.length > 0 && toolCalls === 0 && !askedQuestion;
	return {
		turnIndex: turn.index,
		...(turn.userEntryId ? { userEntryId: turn.userEntryId } : {}),
		userChars: turn.userChars,
		requests: requests.length,
		outputTokens: requests.reduce((sum, rp) => sum + rp.usage.output, 0),
		cost: requests.reduce((sum, rp) => sum + rp.usage.cost, 0),
		peakContextTokens: requests.reduce((max, rp) => Math.max(max, rp.usage.contextTokens), 0),
		askedQuestion,
		narrationOnly,
		toolCalls,
		toolCallsByName,
		filesRead: [...filesRead],
		filesEdited: [...filesEdited],
		editChurn,
		testsRun,
		toolErrors,
		toolErrorsByName,
		errorRunMax,
		repeatedErrorText,
		missingPathErrors,
		repeatedIdenticalCalls,
		immediateRepeats,
		errorFollowUps,
		rereadAfterCompaction,
		staleFilesInContext: last ? staleFiles(last, state.lastWriteByPath, readPositions, branchIndex) : [],
		textBeforeFirstTool,
		finalTextChars: finalText.length,
		longResponses,
		veryLongResponses,
		correctionTurn: false,
		rewinds: 0,
		branchSummaries: 0,
		aborted,
		cacheHitRatioMin: Number.isFinite(cacheHitRatioMin) ? cacheHitRatioMin : Number.NaN,
		cacheDrops,
		modelChanges: 0,
		thinkingChanges: 0,
		injections,
		models: [...models],
	};
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function assistantTextOf(session: Session, rp: RequestPoint): string {
	const entry = session.byId.get(rp.assistantEntryId);
	if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return "";
	return (entry.message.content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function textBeforeFirstCall(session: Session, rp: RequestPoint): number {
	const entry = session.byId.get(rp.assistantEntryId);
	if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return 0;
	let chars = 0;
	for (const block of entry.message.content ?? []) {
		if (block.type === "toolCall") break;
		if (block.type === "text") chars += (block.text ?? "").length;
	}
	return chars;
}

/** Paths with a successful read result still in the request's context, written to after that read. */
function staleFiles(rp: RequestPoint, lastWriteByPath: Map<string, number>, readPositions: Map<string, number[]>, branchIndex: Map<string, number>): string[] {
	const inContext = new Set(rp.context.entries.map((entry) => branchIndex.get(entry.id)));
	const stale: string[] = [];
	for (const [path, writePosition] of lastWriteByPath) {
		const reads = readPositions.get(path) ?? [];
		if (reads.some((position) => position < writePosition && inContext.has(position))) stale.push(path);
	}
	return stale.sort();
}

// ── Findings ───────────────────────────────────────────────────────────────

/** One-line findings from the per-turn observables, for the JSON contract and the terminal. */
export function sessionFindings(session: Session, turns: TurnObservables[]): Finding[] {
	const findings: Finding[] = [];
	const evidence = (turn: TurnObservables) => (turn.userEntryId ? [turn.userEntryId] : []);
	for (const turn of turns) {
		if (turn.errorRunMax >= THRESHOLDS.errorRunWarn) findings.push({ kind: "error_run", severity: "warn", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.errorRunMax} consecutive tool errors` });
		if (turn.immediateRepeats > 0) findings.push({ kind: "repeated_identical_call", severity: "warn", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.immediateRepeats} identical call(s) repeated immediately` });
		if (turn.errorFollowUps.identical + turn.errorFollowUps.otherTarget > 0) findings.push({ kind: "error_follow_up", severity: "warn", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `after an error: ${turn.errorFollowUps.identical} identical retry(ies), ${turn.errorFollowUps.otherTarget} guess(es) at another target` });
		if (turn.missingPathErrors > 0) findings.push({ kind: "missing_path_error", severity: "info", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.missingPathErrors} missing-path error(s)` });
		if (turn.correctionTurn) findings.push({ kind: "correction_turn", severity: "warn", turnIndex: turn.turnIndex, evidence: evidence(turn), message: "user corrected the previous turn" });
		if (turn.rewinds > 0) findings.push({ kind: "rewind", severity: "warn", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.rewinds} rewind(s) from this turn` });
		if (turn.aborted > 0) findings.push({ kind: "aborted", severity: "warn", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.aborted} request(s) aborted or errored` });
		if (turn.cacheDrops > 0) findings.push({ kind: "cache_hit_ratio", severity: "info", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `cache hit ratio dropped by ${THRESHOLDS.cacheDropPoints}+ points` });
		if (turn.staleFilesInContext.length > 0) findings.push({ kind: "stale_file_in_context", severity: "info", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `stale read in context: ${turn.staleFilesInContext.join(", ")}` });
		if (turn.rereadAfterCompaction > 0) findings.push({ kind: "reread_after_compaction", severity: "info", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.rereadAfterCompaction} file(s) read again after compaction` });
		if (turn.veryLongResponses > 0) findings.push({ kind: "long_response", severity: "info", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.veryLongResponses} response(s) over ${THRESHOLDS.veryLongResponseChars} chars` });
		if (turn.editChurn > 0) findings.push({ kind: "edit_churn", severity: "info", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `${turn.editChurn} repeated or reverting edit(s)` });
		if (turn.peakContextTokens > THRESHOLDS.largeContextTokens) findings.push({ kind: "large_context", severity: "info", turnIndex: turn.turnIndex, evidence: evidence(turn), message: `context ${Math.round(turn.peakContextTokens / 1000)}k tokens` });
	}
	for (const compaction of session.compactions) {
		findings.push({ kind: "compaction", severity: "info", turnIndex: compaction.turnIndex, evidence: [compaction.id], message: `compacted ${Math.round(compaction.tokensBefore / 1000)}k tokens` });
	}
	return findings.sort((a, b) => a.turnIndex - b.turnIndex);
}

// ── Session summary ────────────────────────────────────────────────────────

export interface ModelMix {
	model: string;
	requests: number;
	cost: number;
	outputTokens: number;
}

export interface SessionSummary {
	path: string;
	id: string;
	cwd: string;
	startedAt: string;
	durationMs: number;
	turns: number;
	requests: number;
	cost: number;
	/** Cost of usage entries, compactions and branch summaries that are not assistant requests. */
	otherCost: number;
	peakContextTokens: number;
	compactions: number;
	compactionTokensBefore: number[];
	forks: number;
	branchSummaries: number;
	modelMix: ModelMix[];
	/** Share of the session's cost in its most expensive request and its five most expensive. */
	topRequestCostShare: number;
	top5RequestCostShare: number;
	toolCalls: number;
	toolCallsByName: Record<string, number>;
	toolErrors: number;
	toolErrorsByName: Record<string, number>;
	missingPathErrors: number;
	failedCommands: number;
	repeatedIdenticalCalls: number;
	immediateRepeats: number;
	errorFollowUps: Record<ErrorFollowUp, number>;
	errorRunMax: number;
	repeatedErrorText: number;
	rereadAfterCompaction: number;
	staleFileTurns: number;
	editChurn: number;
	testsRun: number;
	askedQuestions: number;
	narrationOnlyTurns: number;
	longResponses: number;
	veryLongResponses: number;
	correctionTurns: number;
	rewinds: number;
	aborted: number;
	cacheDrops: number;
	cacheHitRatioMean: number;
	modelChanges: number;
	thinkingChanges: number;
	injections: Record<string, number>;
	findings: Finding[];
	turnObservables: TurnObservables[];
}

export function sessionSummary(session: Session): SessionSummary {
	const turns = turnObservables(session);
	const findings = sessionFindings(session, turns);
	const sum = (pick: (turn: TurnObservables) => number) => turns.reduce((total, turn) => total + pick(turn), 0);
	const merge = (pick: (turn: TurnObservables) => Record<string, number>) => {
		const out: Record<string, number> = {};
		for (const turn of turns) for (const [key, value] of Object.entries(pick(turn))) out[key] = (out[key] ?? 0) + value;
		return out;
	};
	const costs = session.requestPoints.map((rp) => rp.usage.cost).sort((a, b) => b - a);
	const cost = costs.reduce((total, value) => total + value, 0);
	const topShare = (n: number) => (cost > 0 ? costs.slice(0, n).reduce((total, value) => total + value, 0) / cost : 0);
	const mix = new Map<string, ModelMix>();
	for (const rp of session.requestPoints) {
		const row = mix.get(rp.model) ?? { model: rp.model, requests: 0, cost: 0, outputTokens: 0 };
		row.requests++;
		row.cost += rp.usage.cost;
		row.outputTokens += rp.usage.output;
		mix.set(rp.model, row);
	}
	const ratios = session.requestPoints.map(cacheHitRatio).filter((ratio) => !Number.isNaN(ratio));
	let otherCost = 0;
	for (const entry of session.entries) {
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") otherCost += entry.usage?.cost?.total ?? 0;
	}
	const toolErrorsByName = merge((turn) => turn.toolErrorsByName);
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		startedAt: session.startedAt,
		durationMs: session.durationMs,
		turns: session.turns.filter((turn) => turn.index > 0 && !turnBeforeWindow(session, turn.index)).length,
		requests: session.requestPoints.length,
		cost,
		otherCost,
		peakContextTokens: session.requestPoints.reduce((max, rp) => Math.max(max, rp.usage.contextTokens), 0),
		compactions: session.compactions.length,
		compactionTokensBefore: session.compactions.map((compaction) => compaction.tokensBefore),
		forks: session.forks.length,
		branchSummaries: session.branchSummaryCount,
		modelMix: [...mix.values()].sort((a, b) => b.cost - a.cost),
		topRequestCostShare: topShare(1),
		top5RequestCostShare: topShare(5),
		toolCalls: sum((turn) => turn.toolCalls),
		toolCallsByName: merge((turn) => turn.toolCallsByName),
		toolErrors: sum((turn) => turn.toolErrors),
		toolErrorsByName,
		missingPathErrors: sum((turn) => turn.missingPathErrors),
		failedCommands: [...SHELL_TOOLS].reduce((total, name) => total + (toolErrorsByName[name] ?? 0), 0),
		repeatedIdenticalCalls: sum((turn) => turn.repeatedIdenticalCalls),
		immediateRepeats: sum((turn) => turn.immediateRepeats),
		errorFollowUps: sumFollowUps(turns.map((turn) => turn.errorFollowUps)),
		errorRunMax: turns.reduce((max, turn) => Math.max(max, turn.errorRunMax), 0),
		repeatedErrorText: sum((turn) => turn.repeatedErrorText),
		rereadAfterCompaction: sum((turn) => turn.rereadAfterCompaction),
		staleFileTurns: turns.filter((turn) => turn.staleFilesInContext.length > 0).length,
		editChurn: sum((turn) => turn.editChurn),
		testsRun: sum((turn) => turn.testsRun),
		askedQuestions: turns.filter((turn) => turn.askedQuestion).length,
		narrationOnlyTurns: turns.filter((turn) => turn.narrationOnly).length,
		longResponses: sum((turn) => turn.longResponses),
		veryLongResponses: sum((turn) => turn.veryLongResponses),
		correctionTurns: turns.filter((turn) => turn.correctionTurn).length,
		rewinds: sum((turn) => turn.rewinds),
		aborted: sum((turn) => turn.aborted),
		cacheDrops: sum((turn) => turn.cacheDrops),
		cacheHitRatioMean: ratios.length > 0 ? ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length : Number.NaN,
		modelChanges: session.entryTypeCounts.model_change ?? 0,
		thinkingChanges: session.entryTypeCounts.thinking_level_change ?? 0,
		injections: merge((turn) => turn.injections),
		findings,
		turnObservables: turns,
	};
}

export function sumFollowUps(items: Record<ErrorFollowUp, number>[]): Record<ErrorFollowUp, number> {
	const total = emptyFollowUps();
	for (const item of items) for (const key of ERROR_FOLLOW_UPS) total[key] += item[key];
	return total;
}

export function formatFollowUps(followUps: Record<ErrorFollowUp, number>): string {
	return `${followUps.identical} identical, ${followUps.sameTarget} same target, ${followUps.otherTarget} other target, ${followUps.otherTool} other tool, ${followUps.none} none`;
}

// ── Directory summary (the audit's quantitative section) ───────────────────

export interface DirectorySummary {
	sessions: number;
	requests: number;
	cost: number;
	otherCost: number;
	/** Share of total cost in the most expensive session and the five most expensive. */
	topSessionCostShare: number;
	top5SessionCostShare: number;
	modelMix: (ModelMix & { requestShare: number; costShare: number })[];
	toolErrors: number;
	toolErrorsByName: Record<string, number>;
	missingPathErrors: number;
	failedCommands: number;
	immediateRepeats: number;
	errorFollowUps: Record<ErrorFollowUp, number>;
	repeatedIdenticalCalls: number;
	compactions: number;
	peakContextTokens: number;
	longResponses: number;
	veryLongResponses: number;
	correctionTurns: number;
	rewinds: number;
	aborted: number;
	askedQuestions: number;
	narrationOnlyTurns: number;
	testsRun: number;
	sessionsBySize: { path: string; cost: number; requests: number; peakContextTokens: number }[];
}

export function directorySummary(summaries: SessionSummary[]): DirectorySummary {
	const sum = (pick: (summary: SessionSummary) => number) => summaries.reduce((total, summary) => total + pick(summary), 0);
	const cost = sum((summary) => summary.cost);
	const sortedCosts = summaries.map((summary) => summary.cost).sort((a, b) => b - a);
	const topShare = (n: number) => (cost > 0 ? sortedCosts.slice(0, n).reduce((total, value) => total + value, 0) / cost : 0);
	const mix = new Map<string, ModelMix>();
	for (const summary of summaries) {
		for (const row of summary.modelMix) {
			const merged = mix.get(row.model) ?? { model: row.model, requests: 0, cost: 0, outputTokens: 0 };
			merged.requests += row.requests;
			merged.cost += row.cost;
			merged.outputTokens += row.outputTokens;
			mix.set(row.model, merged);
		}
	}
	const requests = sum((summary) => summary.requests);
	const toolErrorsByName: Record<string, number> = {};
	for (const summary of summaries) for (const [name, count] of Object.entries(summary.toolErrorsByName)) toolErrorsByName[name] = (toolErrorsByName[name] ?? 0) + count;
	return {
		sessions: summaries.length,
		requests,
		cost,
		otherCost: sum((summary) => summary.otherCost),
		topSessionCostShare: topShare(1),
		top5SessionCostShare: topShare(5),
		modelMix: [...mix.values()]
			.sort((a, b) => b.cost - a.cost)
			.map((row) => ({ ...row, requestShare: requests > 0 ? row.requests / requests : 0, costShare: cost > 0 ? row.cost / cost : 0 })),
		toolErrors: sum((summary) => summary.toolErrors),
		toolErrorsByName,
		missingPathErrors: sum((summary) => summary.missingPathErrors),
		failedCommands: sum((summary) => summary.failedCommands),
		immediateRepeats: sum((summary) => summary.immediateRepeats),
		errorFollowUps: sumFollowUps(summaries.map((summary) => summary.errorFollowUps)),
		repeatedIdenticalCalls: sum((summary) => summary.repeatedIdenticalCalls),
		compactions: sum((summary) => summary.compactions),
		peakContextTokens: summaries.reduce((max, summary) => Math.max(max, summary.peakContextTokens), 0),
		longResponses: sum((summary) => summary.longResponses),
		veryLongResponses: sum((summary) => summary.veryLongResponses),
		correctionTurns: sum((summary) => summary.correctionTurns),
		rewinds: sum((summary) => summary.rewinds),
		aborted: sum((summary) => summary.aborted),
		askedQuestions: sum((summary) => summary.askedQuestions),
		narrationOnlyTurns: sum((summary) => summary.narrationOnlyTurns),
		testsRun: sum((summary) => summary.testsRun),
		sessionsBySize: summaries
			.map((summary) => ({ path: summary.path, cost: summary.cost, requests: summary.requests, peakContextTokens: summary.peakContextTokens }))
			.sort((a, b) => b.cost - a.cost),
	};
}
