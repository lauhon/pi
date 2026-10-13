/**
 * The labeling pass (step 4): the worksheet behind `label <file>` and the checks behind
 * `labels <json>`. Pure functions over a Session and its turn observables; cli.ts renders them.
 */
import { THRESHOLDS, assistantTextOf, type TurnObservables } from "./observables.ts";
import type { Session } from "./types.ts";

export const OUTCOMES = ["good", "bad", "mixed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The rows of the spec's "Why this shape" table, in its order, plus unknown. */
export const LEVELS = ["prompt", "instructions", "model", "structure", "process", "tooling", "habit", "unknown"] as const;
export type Level = (typeof LEVELS)[number];

/** Step 4 is done at this many labeled sessions (work breakdown, row 4). */
export const LABEL_TARGET = 20;

export const EXCERPT_CHARS = { user: 240, final: 160 };

/** One record of reports/session-labels.json. */
export interface SessionLabel {
	session: string;
	outcome: Outcome;
	/** The turn (as `summary` numbers them) at which a different move would have saved the session. */
	earliestSaveTurn?: number;
	level?: Level;
	note?: string;
}

const LABEL_KEYS = new Set(["session", "outcome", "earliestSaveTurn", "level", "note"]);

export function isOutcome(value: unknown): value is Outcome {
	return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

export function isLevel(value: unknown): value is Level {
	return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export interface ParsedLabels {
	labels: SessionLabel[];
	problems: string[];
}

/**
 * Parse the labels file. A record is kept when it names a session and has a valid outcome;
 * a field with a wrong value is dropped from the record and named in `problems`, as is a
 * missing field a bad session needs, an unknown key, and a session labeled twice.
 */
export function parseLabels(text: string): ParsedLabels {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { labels: [], problems: [`not JSON: ${(error as Error).message}`] };
	}
	if (!Array.isArray(parsed)) return { labels: [], problems: ["the file must hold an array of records"] };
	const labels: SessionLabel[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	parsed.forEach((record: unknown, index) => {
		if (typeof record !== "object" || record === null || Array.isArray(record)) {
			problems.push(`record ${index}: not an object`);
			return;
		}
		const row = record as Record<string, unknown>;
		const session = typeof row.session === "string" && row.session.length > 0 ? row.session : undefined;
		const where = session ? `record ${index} (${session})` : `record ${index}`;
		for (const key of Object.keys(row)) if (!LABEL_KEYS.has(key)) problems.push(`${where}: unknown key "${key}"`);
		if (!session) problems.push(`${where}: "session" must be a non-empty string`);
		if (!isOutcome(row.outcome)) problems.push(`${where}: "outcome" must be one of ${OUTCOMES.join(", ")}`);
		const turn = Number.isInteger(row.earliestSaveTurn) && (row.earliestSaveTurn as number) >= 0 ? (row.earliestSaveTurn as number) : undefined;
		if (row.earliestSaveTurn !== undefined && turn === undefined) problems.push(`${where}: "earliestSaveTurn" must be a turn index (an integer, 0 or more)`);
		const level = isLevel(row.level) ? row.level : undefined;
		if (row.level !== undefined && level === undefined) problems.push(`${where}: "level" must be one of ${LEVELS.join(", ")}`);
		const note = typeof row.note === "string" ? row.note : undefined;
		if (row.note !== undefined && note === undefined) problems.push(`${where}: "note" must be a string`);
		if (row.outcome === "bad") {
			if (turn === undefined) problems.push(`${where}: a bad session needs "earliestSaveTurn"`);
			if (level === undefined) problems.push(`${where}: a bad session needs "level"`);
		}
		if (!session || !isOutcome(row.outcome)) return;
		if (seen.has(session)) {
			problems.push(`${where}: labeled twice`);
			return;
		}
		seen.add(session);
		labels.push({
			session,
			outcome: row.outcome,
			...(turn !== undefined ? { earliestSaveTurn: turn } : {}),
			...(level !== undefined ? { level } : {}),
			...(note !== undefined ? { note } : {}),
		});
	});
	return { labels, problems };
}

export interface LevelCluster {
	level: Level | "none";
	bad: number;
	mixed: number;
	good: number;
	total: number;
}

export interface LabelReport {
	count: number;
	byOutcome: Record<Outcome, number>;
	/** Labels by level, largest first: where they cluster is where step 5 looks. */
	clusters: LevelCluster[];
	/** Schema problems, plus the cross-checks against the sessions when `lastTurnOf` is given. */
	problems: string[];
	target: number;
	/** Bad sessions still missing `earliestSaveTurn` or `level`. */
	incomplete: string[];
	/** The step 4 "done when": at least `target` labeled and nothing incomplete. */
	done: boolean;
}

/**
 * Count the labels and check them. `lastTurnOf` returns the last turn index of a labeled
 * session when the caller loaded the sessions, so a turn past the end is caught.
 */
export function labelReport(parsed: ParsedLabels, lastTurnOf?: (session: string) => number | undefined): LabelReport {
	const byOutcome: Record<Outcome, number> = { good: 0, bad: 0, mixed: 0 };
	const clusters = new Map<Level | "none", LevelCluster>();
	const problems = [...parsed.problems];
	const incomplete: string[] = [];
	for (const label of parsed.labels) {
		byOutcome[label.outcome]++;
		const key = label.level ?? "none";
		const cluster = clusters.get(key) ?? { level: key, bad: 0, mixed: 0, good: 0, total: 0 };
		cluster[label.outcome]++;
		cluster.total++;
		clusters.set(key, cluster);
		if (label.outcome === "bad" && (label.earliestSaveTurn === undefined || label.level === undefined)) incomplete.push(label.session);
		if (!lastTurnOf) continue;
		const lastTurn = lastTurnOf(label.session);
		if (lastTurn === undefined) problems.push(`${label.session}: not found under the given directories`);
		else if (label.earliestSaveTurn !== undefined && label.earliestSaveTurn > lastTurn) {
			problems.push(`${label.session}: earliestSaveTurn ${label.earliestSaveTurn} is past the last turn (${lastTurn})`);
		}
	}
	const order = (level: Level | "none") => (level === "none" ? LEVELS.length : LEVELS.indexOf(level));
	return {
		count: parsed.labels.length,
		byOutcome,
		clusters: [...clusters.values()].sort((a, b) => b.total - a.total || order(a.level) - order(b.level)),
		problems,
		target: LABEL_TARGET,
		incomplete,
		done: parsed.labels.length >= LABEL_TARGET && incomplete.length === 0,
	};
}

export type Ending = "answered" | "question" | "interrupted" | "errored" | "midRun" | "unanswered" | "empty";

export const ENDINGS: Record<Ending, string> = {
	answered: "the agent answered",
	question: "the agent asked a question that got no answer",
	interrupted: "you stopped the agent",
	errored: "the provider failed",
	midRun: "a tool call without an answer after it",
	unanswered: "your last message got no answer",
	empty: "no requests",
};

/** What the file says about the outcome: the signals the spec names, with the turns they sit in. */
export interface LabelEvidence {
	rewindTurns: number[];
	correctionTurns: number[];
	interruptedTurns: number[];
	erroredTurns: number[];
	/** Turns with THRESHOLDS.errorRunWarn or more consecutive tool errors. */
	errorRunTurns: number[];
	questionTurns: number[];
	lastTurn: number;
	ending: Ending;
	/** The three most expensive turns. */
	costliestTurns: { turnIndex: number; cost: number }[];
}

export function labelEvidence(session: Session, turns: TurnObservables[]): LabelEvidence {
	const pick = (test: (turn: TurnObservables) => boolean) => turns.filter(test).map((turn) => turn.turnIndex);
	const lastTurn = session.turns[session.turns.length - 1];
	const last = session.requestPoints[session.requestPoints.length - 1];
	let ending: Ending;
	if (last === undefined) ending = lastTurn?.userEntryId ? "unanswered" : "empty";
	else if (lastTurn.requestIndexes.length === 0) ending = "unanswered";
	else if (last.stopReason === "aborted") ending = "interrupted";
	else if (last.stopReason === "error") ending = "errored";
	else if (last.toolCalls.length > 0) ending = "midRun";
	else if (turns.find((turn) => turn.turnIndex === lastTurn.index)?.askedQuestion) ending = "question";
	else ending = "answered";
	return {
		rewindTurns: pick((turn) => turn.rewinds > 0),
		correctionTurns: pick((turn) => turn.correctionTurn),
		interruptedTurns: pick((turn) => turn.interrupted > 0),
		erroredTurns: pick((turn) => turn.errored > 0),
		errorRunTurns: pick((turn) => turn.errorRunMax >= THRESHOLDS.errorRunWarn),
		questionTurns: pick((turn) => turn.askedQuestion),
		lastTurn: lastTurn?.index ?? 0,
		ending,
		costliestTurns: [...turns]
			.filter((turn) => turn.cost > 0)
			.sort((a, b) => b.cost - a.cost || a.turnIndex - b.turnIndex)
			.slice(0, 3)
			.map((turn) => ({ turnIndex: turn.turnIndex, cost: turn.cost })),
	};
}

/** One turn of the worksheet: the counts that matter for a label, the request and the answer in excerpt. */
export interface LabelTurn {
	turnIndex: number;
	/** Since the session started. */
	offsetMs: number;
	requests: number;
	cost: number;
	toolCalls: number;
	toolCallsByName: Record<string, number>;
	toolErrors: number;
	missingPathErrors: number;
	flags: string[];
	user: string;
	final: string;
	finalTextChars: number;
}

export function labelTurns(session: Session, turns: TurnObservables[]): LabelTurn[] {
	const start = Date.parse(session.startedAt);
	const byIndex = new Map(session.turns.map((turn) => [turn.index, turn]));
	return turns.map((turn) => {
		const source = byIndex.get(turn.turnIndex);
		const lastIndex = source?.requestIndexes[source.requestIndexes.length - 1];
		const last = lastIndex === undefined ? undefined : session.requestPoints[lastIndex];
		const started = source ? Date.parse(source.startedAt) : Number.NaN;
		return {
			turnIndex: turn.turnIndex,
			offsetMs: Number.isFinite(started - start) ? Math.max(0, started - start) : 0,
			requests: turn.requests,
			cost: turn.cost,
			toolCalls: turn.toolCalls,
			toolCallsByName: turn.toolCallsByName,
			toolErrors: turn.toolErrors,
			missingPathErrors: turn.missingPathErrors,
			flags: turnFlags(turn),
			user: excerpt(source?.userText ?? "", EXCERPT_CHARS.user),
			final: excerpt(last ? assistantTextOf(session, last) : "", EXCERPT_CHARS.final),
			finalTextChars: turn.finalTextChars,
		};
	});
}

/** The short flags of the per-turn tables, one word per signal. */
export function turnFlags(turn: TurnObservables): string[] {
	return [
		turn.askedQuestion ? "q" : "",
		turn.narrationOnly ? "narr" : "",
		turn.correctionTurn ? "corr" : "",
		turn.rewinds > 0 ? `rew${turn.rewinds}` : "",
		turn.interrupted > 0 ? "interrupted" : "",
		turn.errored > 0 ? "errored" : "",
		turn.errorRunMax >= THRESHOLDS.errorRunWarn ? `errrun${turn.errorRunMax}` : "",
		turn.longResponses > 0 ? (turn.veryLongResponses > 0 ? "long5k" : "long") : "",
		turn.cacheDrops > 0 ? "drop" : "",
		turn.rereadAfterCompaction > 0 ? "reread" : "",
		turn.modelChanges > 0 ? "model" : "",
		turn.thinkingChanges > 0 ? "think" : "",
		Object.keys(turn.injections).length > 0 ? "inj" : "",
	].filter(Boolean);
}

/** One line of text, whitespace collapsed, cut at `max` characters. */
export function excerpt(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The record to fill in for this session, in the order the spec shows. */
export function labelRecord(session: string): Record<string, unknown> {
	return { session, outcome: "", earliestSaveTurn: null, level: "", note: "" };
}
