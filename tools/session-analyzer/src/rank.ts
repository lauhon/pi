/**
 * Rank sessions for the labeling pass (step 4): a bad-signal score per session.
 */
import type { SessionSummary } from "./observables.ts";
import { THRESHOLDS } from "./observables.ts";

export interface RankComponents {
	correctionTurns: number;
	rewinds: number;
	errorRuns: number;
	repeatedIdenticalCalls: number;
	aborted: number;
	largeContext: number;
}

export interface RankedSession {
	path: string;
	score: number;
	components: RankComponents;
	summary: SessionSummary;
}

/** Each signal saturates at this count, so one runaway signal cannot bury the others. */
export const RANK_CAPS: Record<keyof RankComponents, number> = {
	correctionTurns: 3,
	rewinds: 3,
	errorRuns: 3,
	repeatedIdenticalCalls: 5,
	aborted: 2,
	largeContext: 1,
};

/**
 * Starting point, as the spec says: a plain sum of the normalized signals. Each component is
 * count / cap, clipped to 1; `largeContext` is how far the peak context sits above 200k, in
 * units of 100k, clipped to 1. Revisit once the labels from step 4 say which signals predict a
 * bad session.
 */
export function scoreSession(summary: SessionSummary): RankedSession {
	const errorRuns = summary.turnObservables.filter((turn) => turn.errorRunMax >= THRESHOLDS.errorRunWarn).length;
	const components: RankComponents = {
		correctionTurns: clip(summary.correctionTurns / RANK_CAPS.correctionTurns),
		rewinds: clip(summary.rewinds / RANK_CAPS.rewinds),
		errorRuns: clip(errorRuns / RANK_CAPS.errorRuns),
		repeatedIdenticalCalls: clip(summary.repeatedIdenticalCalls / RANK_CAPS.repeatedIdenticalCalls),
		aborted: clip(summary.aborted / RANK_CAPS.aborted),
		largeContext: clip(Math.max(0, summary.peakContextTokens - THRESHOLDS.largeContextTokens) / 100_000),
	};
	const score = Object.values(components).reduce((total, value) => total + value, 0);
	return { path: summary.path, score: Number(score.toFixed(3)), components, summary };
}

function clip(value: number): number {
	return Number(Math.min(1, Math.max(0, value)).toFixed(3));
}

/** Highest score first; ties broken by cost, then path, so output is stable. */
export function rankSessions(summaries: SessionSummary[]): RankedSession[] {
	return summaries.map(scoreSession).sort((a, b) => b.score - a.score || b.summary.cost - a.summary.cost || a.path.localeCompare(b.path));
}
