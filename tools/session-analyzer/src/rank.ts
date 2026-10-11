/**
 * Rank sessions for the labeling pass (step 4): a bad-signal score per session.
 */
import { percentile } from "./inventory.ts";
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

export type RateSignal = Exclude<keyof RankComponents, "largeContext">;

/** Per-signal scale: the directory's 90th percentile of the rate per 100 requests. */
export type RankScales = Record<RateSignal, number>;

export interface RankedSession {
	path: string;
	score: number;
	components: RankComponents;
	/** The raw signals per 100 requests, before scaling. */
	rates: Record<RateSignal, number>;
	summary: SessionSummary;
}

export const RATE_SIGNALS: RateSignal[] = ["correctionTurns", "rewinds", "errorRuns", "repeatedIdenticalCalls", "aborted"];

/**
 * Floor for the rate denominator. One aborted request in a four-request session is a 25% rate
 * and would top every ranking; with the floor it counts as 5%, so tiny sessions need several
 * signals before they outrank a long session with a real pattern.
 */
export const RANK_MIN_REQUESTS = 20;

function count(summary: SessionSummary, signal: RateSignal): number {
	if (signal === "errorRuns") return summary.turnObservables.filter((turn) => turn.errorRunMax >= THRESHOLDS.errorRunWarn).length;
	return summary[signal];
}

/** Signal count per 100 assistant requests (at least RANK_MIN_REQUESTS), so a 1,600-request session is not "bad" by size alone. */
export function rateOf(summary: SessionSummary, signal: RateSignal): number {
	return summary.requests > 0 ? (count(summary, signal) / Math.max(summary.requests, RANK_MIN_REQUESTS)) * 100 : 0;
}

/** The 90th percentile of each rate over the sessions being ranked; the maximum when p90 is 0; 1 when every session is 0. */
export function rankScales(summaries: SessionSummary[]): RankScales {
	const scales = {} as RankScales;
	for (const signal of RATE_SIGNALS) {
		const rates = summaries.map((summary) => rateOf(summary, signal)).sort((a, b) => a - b);
		const p90 = percentile(rates, 0.9);
		const max = rates[rates.length - 1] ?? 0;
		scales[signal] = p90 > 0 ? p90 : max > 0 ? max : 1;
	}
	return scales;
}

/**
 * Starting point, as the spec says: a plain sum of the normalized signals. Each rate signal is
 * its rate per 100 requests over the directory's 90th percentile, clipped to 1, so the score
 * compares sessions of different sizes; `largeContext` is how far the peak context sits above
 * 200k, in units of 100k, clipped to 1. The first real run showed that raw counts with fixed
 * caps saturate on every session above about 300 requests, which is why rates are used.
 * Revisit once the labels from step 4 say which signals predict a bad session.
 */
export function scoreSession(summary: SessionSummary, scales: RankScales = rankScales([summary])): RankedSession {
	const rates = {} as Record<RateSignal, number>;
	const components = {} as RankComponents;
	for (const signal of RATE_SIGNALS) {
		rates[signal] = Number(rateOf(summary, signal).toFixed(3));
		components[signal] = clip(rates[signal] / scales[signal]);
	}
	components.largeContext = clip(Math.max(0, summary.peakContextTokens - THRESHOLDS.largeContextTokens) / 100_000);
	const score = Object.values(components).reduce((total, value) => total + value, 0);
	return { path: summary.path, score: Number(score.toFixed(3)), components, rates, summary };
}

function clip(value: number): number {
	return Number(Math.min(1, Math.max(0, value)).toFixed(3));
}

/** Highest score first; ties broken by cost, then path, so output is stable. */
export function rankSessions(summaries: SessionSummary[]): RankedSession[] {
	const scales = rankScales(summaries);
	return summaries
		.map((summary) => scoreSession(summary, scales))
		.sort((a, b) => b.score - a.score || b.summary.cost - a.summary.cost || a.path.localeCompare(b.path));
}
