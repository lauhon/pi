/**
 * Time windows over a loaded session.
 *
 * `until` is handled at load time by truncating the file (load.ts ParseOptions), which is the
 * session exactly as it was at that moment. `since` cannot truncate from the front without
 * breaking the tree, so it drops the request points before the cut and renumbers them; turn
 * indexes stay as loaded so they still match `inspect`, and summaries skip a turn that lies
 * entirely before the window.
 */
import { parseTime } from "./load.ts";
import type { Session } from "./types.ts";

/** The session restricted to requests at or after `since`, or null when none remain. */
export function sliceSince(session: Session, since: string): Session | null {
	const sinceMs = parseTime(since, "since");
	const kept = session.requestPoints.filter((rp) => Date.parse(rp.timestamp) >= sinceMs);
	if (kept.length === 0) return null;
	const newIndex = new Map<number, number>();
	kept.forEach((rp, i) => newIndex.set(rp.index, i));
	const requestPoints = kept.map((rp, i) => ({ ...rp, index: i }));
	const turns = session.turns.map((turn) => ({
		...turn,
		requestIndexes: turn.requestIndexes.filter((index) => newIndex.has(index)).map((index) => newIndex.get(index)!),
	}));
	return {
		...session,
		window: { ...session.window, since },
		requestPoints,
		turns,
		forks: session.forks.filter((fork) => {
			const parent = fork.parentId ? session.byId.get(fork.parentId) : undefined;
			return parent === undefined || Date.parse(parent.timestamp) >= sinceMs;
		}),
		compactions: session.compactions.filter((compaction) => {
			const entry = session.byId.get(compaction.id);
			return entry !== undefined && Date.parse(entry.timestamp) >= sinceMs;
		}),
		startedAt: new Date(Math.max(sinceMs, Date.parse(session.startedAt) || sinceMs)).toISOString(),
		durationMs: Math.max(0, Date.parse(session.endedAt) - Math.max(sinceMs, Date.parse(session.startedAt) || sinceMs)) || 0,
	};
}

/** Whether a turn lies entirely before the session's `since` window and has no request in it. */
export function turnBeforeWindow(session: Session, turnIndex: number): boolean {
	const since = session.window?.since;
	if (since === undefined) return false;
	const turn = session.turns[turnIndex];
	if (!turn) return false;
	return turn.requestIndexes.length === 0 && Date.parse(turn.startedAt) < parseTime(since, "since");
}
