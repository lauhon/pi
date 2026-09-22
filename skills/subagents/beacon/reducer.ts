/**
 * Pure beacon reducer.
 *
 * Everything the child's control plane decides lives here: when a turn is
 * injected, what `state.json` should say, who typed a message, when the child
 * may reap itself. No filesystem, no pi, no clock, no randomness — the adapter
 * (index.ts) feeds it events and executes the effects it returns.
 *
 * See skills/subagents/spec-interactive-children.md, "Child lifecycle" and
 * "Who typed it, and what a 'turn' is".
 */

export type BeaconPhase = "starting" | "running" | "blocked" | "idle" | "closed";

export type ControlVerb = "abort" | "quit";

export type TurnOrigin = "parent" | "human" | "mixed" | "unknown";

/** One file found in `inbox/`, already read (or rejected) by the adapter. */
export type InboxItem =
	| { readonly seq: number; readonly name: string; readonly ok: true; readonly text: string }
	| { readonly seq: number; readonly name: string; readonly ok: false; readonly reason: string };

/** A user/assistant entry of the child's own session branch, flattened. */
export interface BranchEntry {
	readonly id: string;
	readonly role: "user" | "assistant";
	readonly text: string;
}

export interface TurnRecord {
	readonly turn: number;
	readonly origin: TurnOrigin;
	readonly userEntries: readonly string[];
	readonly inbox: readonly number[];
	readonly out: string;
	readonly ts: number;
}

export type BeaconEvent =
	| {
			/**
			 * Fired once per process, before the first poll. Rehydrates a beacon
			 * that is resuming an existing run dir (respawn after `kill`/`open`):
			 * turn numbers and provenance accounting belong to the run dir, not the
			 * process, so a fresh `createInitialState` would renumber turn 1 over
			 * the old one and re-count the previous run's user entries as new
			 * (spec, "Beacon contract (frozen, phase 1)"). No-op (resumeTurn 0,
			 * empty knownEntryIds) on a genuinely fresh run dir.
			 */
			readonly type: "sessionStart";
			readonly resumeTurn: number;
			readonly knownEntryIds: readonly string[];
	  }
	| {
			readonly type: "poll";
			readonly now: number;
			readonly inbox: readonly InboxItem[];
			readonly control: readonly ControlVerb[];
			readonly clientAttached: boolean;
	  }
	| { readonly type: "agentStart"; readonly now: number }
	| {
			readonly type: "agentSettled";
			readonly now: number;
			readonly entries: readonly BranchEntry[];
			readonly inbox: readonly InboxItem[];
	  }
	| { readonly type: "uiPromptStart"; readonly now: number }
	| { readonly type: "uiPromptEnd"; readonly now: number }
	| { readonly type: "sessionShutdown"; readonly now: number };

export type BeaconEffect =
	| { readonly type: "writeState"; readonly phase: BeaconPhase; readonly turn: number; readonly since: number }
	| { readonly type: "renameInbox"; readonly name: string; readonly to: "sent" | "rejected" }
	| { readonly type: "deleteControl"; readonly verb: ControlVerb }
	| { readonly type: "sendUser"; readonly text: string; readonly deliverAs: "followUp" | undefined }
	| { readonly type: "writeOutput"; readonly turn: number; readonly text: string }
	| { readonly type: "appendTurn"; readonly record: TurnRecord }
	| { readonly type: "touchIdle"; readonly turn: number }
	| { readonly type: "abort" }
	| { readonly type: "shutdown"; readonly reason: "control" | "ttl" }
	| { readonly type: "log"; readonly level: "info" | "warn"; readonly message: string };

export interface BeaconConfig {
	/** Reap an idle child after this long without a client. */
	readonly idleTtlMs: number;
}

/** A message the beacon injected and has not yet seen come back in the branch. */
interface PendingInjection {
	readonly seq: number;
	readonly normalized: string;
}

export interface BeaconState {
	readonly config: BeaconConfig;
	readonly phase: BeaconPhase;
	/** Number of settles observed so far; `out-N.md` / `idle-N` use this. */
	readonly turn: number;
	/** When the current phase was last written. */
	readonly since: number;
	/** `agent_start` seen without a matching `agent_settled`. */
	readonly streaming: boolean;
	/** Nesting depth of open `ui_prompt_*` spans (V11 coalesces them). */
	readonly promptDepth: number;
	/** Ordered queue of injected-but-unaccounted messages (provenance matching). */
	readonly pending: readonly PendingInjection[];
	/** Inbox file names already handled, so a re-poll cannot inject twice. */
	readonly drained: readonly string[];
	/** Branch entry ids already covered by a previous settle. */
	readonly accounted: readonly string[];
	/** A shutdown has been requested; stop taking work. */
	readonly quitting: boolean;
}

export function createInitialState(config: BeaconConfig, now: number): BeaconState {
	return {
		config,
		phase: "starting",
		turn: 0,
		since: now,
		streaming: false,
		promptDepth: 0,
		pending: [],
		drained: [],
		accounted: [],
		quitting: false,
	};
}

/**
 * The one normalization both sides must agree on. `sendUserMessage("text")` is
 * persisted as a content array (V8), so the parent's plain text and the child's
 * stored entry only compare equal after this.
 */
export function normalizeText(text: string): string {
	return text.replace(/\s+$/, "");
}

/** Flatten a session message content value into the normalized comparison form. */
export function normalizeContent(
	content: string | ReadonlyArray<{ type: string; text?: string }>,
): string {
	if (typeof content === "string") return normalizeText(content);
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return normalizeText(parts.join("\n"));
}

interface Draft {
	state: BeaconState;
	effects: BeaconEffect[];
}

function writePhase(draft: Draft, phase: BeaconPhase, now: number): void {
	draft.state = { ...draft.state, phase, since: now };
	draft.effects.push({ type: "writeState", phase, turn: draft.state.turn, since: now });
}

/**
 * Inject every unseen, readable inbox file in sequence order.
 *
 * E21: `writeState(running)` is emitted *before* the first `sendUser`, so a
 * poller can never observe "inbox drained, still idle".
 * Returns true when at least one message was injected.
 */
function drainInbox(draft: Draft, inbox: readonly InboxItem[], now: number): boolean {
	if (draft.state.quitting) return false;
	const fresh = [...inbox]
		.filter((item) => !draft.state.drained.includes(item.name))
		.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
	if (fresh.length === 0) return false;

	const rejected = fresh.filter((item) => !item.ok);
	const usable = fresh.filter((item): item is Extract<InboxItem, { ok: true }> => item.ok);

	for (const item of rejected) {
		draft.effects.push({ type: "renameInbox", name: item.name, to: "rejected" });
		draft.effects.push({
			type: "log",
			level: "warn",
			message: `rejected inbox file ${item.name}: ${item.ok ? "" : item.reason}`,
		});
	}
	const drained = [...draft.state.drained, ...fresh.map((item) => item.name)];
	draft.state = { ...draft.state, drained };

	if (usable.length === 0) return false;

	writePhase(draft, "running", now);
	let streaming = draft.state.streaming;
	const pending = [...draft.state.pending];
	for (const item of usable) {
		draft.effects.push({ type: "renameInbox", name: item.name, to: "sent" });
		draft.effects.push({
			type: "sendUser",
			text: item.text,
			deliverAs: streaming ? "followUp" : undefined,
		});
		pending.push({ seq: item.seq, normalized: normalizeText(item.text) });
		streaming = true;
	}
	draft.state = { ...draft.state, pending, streaming };
	return true;
}

/**
 * E11: any `NNN.md` still sitting in the inbox is work the parent believes is
 * pending. Note this counts files the reducer already drained: if the rename to
 * `.sent` failed (E14, read-only or vanished run dir) the parent still sees a
 * queued turn, and reaping under it would silently drop that turn.
 */
function hasUndrainedWork(_state: BeaconState, inbox: readonly InboxItem[]): boolean {
	return inbox.length > 0;
}

function handlePoll(draft: Draft, event: Extract<BeaconEvent, { type: "poll" }>): void {
	const { now, inbox, control, clientAttached } = event;

	// abort before quit: `ctx.shutdown()` defers until idle (V10), so a kill that
	// did not abort first would sit behind the very work it is trying to stop.
	if (control.includes("abort")) {
		draft.effects.push({ type: "deleteControl", verb: "abort" });
		draft.effects.push({ type: "abort" });
	}
	if (control.includes("quit")) {
		draft.effects.push({ type: "deleteControl", verb: "quit" });
		if (!draft.state.quitting) {
			draft.state = { ...draft.state, quitting: true };
			draft.effects.push({ type: "shutdown", reason: "control" });
		}
	}

	if (drainInbox(draft, inbox, now)) return;

	const s = draft.state;
	const reapable = s.phase === "idle" || s.phase === "starting";
	if (
		reapable &&
		!s.quitting &&
		!clientAttached && // E10
		!hasUndrainedWork(s, inbox) && // E11
		s.pending.length === 0 &&
		s.promptDepth === 0 &&
		now - s.since >= s.config.idleTtlMs
	) {
		draft.state = { ...draft.state, quitting: true };
		draft.effects.push({
			type: "log",
			level: "info",
			message: `idle for ${Math.round((now - s.since) / 1000)}s with no client — reaping`,
		});
		draft.effects.push({ type: "shutdown", reason: "ttl" });
	}
}

/** Ordered provenance matching over the entries this settle newly covers. */
function accountEntries(
	state: BeaconState,
	entries: readonly BranchEntry[],
): {
	readonly fresh: readonly BranchEntry[];
	readonly userEntries: string[];
	readonly inboxSeqs: number[];
	readonly origin: TurnOrigin;
	readonly pending: readonly PendingInjection[];
} {
	const fresh = entries.filter((entry) => !state.accounted.includes(entry.id));
	const queue = [...state.pending];
	const userEntries: string[] = [];
	const inboxSeqs: number[] = [];
	let fromParent = 0;
	let fromHuman = 0;

	for (const entry of fresh) {
		if (entry.role !== "user") continue;
		userEntries.push(entry.id);
		const head = queue[0];
		if (head !== undefined && head.normalized === normalizeText(entry.text)) {
			queue.shift();
			inboxSeqs.push(head.seq);
			fromParent++;
		} else {
			fromHuman++;
		}
	}

	const origin: TurnOrigin =
		fromParent > 0 && fromHuman > 0
			? "mixed"
			: fromParent > 0
				? "parent"
				: fromHuman > 0
					? "human"
					: "unknown";
	return { fresh, userEntries, inboxSeqs, origin, pending: queue };
}

function handleSettled(draft: Draft, event: Extract<BeaconEvent, { type: "agentSettled" }>): void {
	const { now, entries, inbox } = event;
	const { fresh, userEntries, inboxSeqs, origin, pending } = accountEntries(draft.state, entries);

	const turn = draft.state.turn + 1;
	// Last assistant text that actually said something: a trailing tool-call-only
	// message has no text and must not blank out-N.md.
	let lastAssistant = "";
	for (const entry of fresh) {
		if (entry.role === "assistant" && entry.text !== "") lastAssistant = entry.text;
	}

	draft.state = {
		...draft.state,
		turn,
		streaming: false,
		pending,
		accounted: [...draft.state.accounted, ...fresh.map((e) => e.id)],
	};

	// out-N before idle-N: anything that wakes on the marker must find the output.
	draft.effects.push({ type: "writeOutput", turn, text: lastAssistant });
	draft.effects.push({
		type: "appendTurn",
		record: { turn, origin, userEntries, inbox: inboxSeqs, out: `out-${turn}.md`, ts: now },
	});
	draft.effects.push({ type: "touchIdle", turn });

	if (draft.state.promptDepth > 0) {
		writePhase(draft, "blocked", now); // E22
		return;
	}
	if (drainInbox(draft, inbox, now)) return; // undrained inbox is not idle
	if (draft.state.pending.length > 0) {
		// injected but not yet visible in the branch — the turn is still ours
		writePhase(draft, "running", now);
		return;
	}
	writePhase(draft, "idle", now);
}

export function reduce(
	state: BeaconState,
	event: BeaconEvent,
): { state: BeaconState; effects: BeaconEffect[] } {
	const draft: Draft = { state, effects: [] };

	switch (event.type) {
		case "sessionStart":
			draft.state = {
				...draft.state,
				turn: Math.max(draft.state.turn, event.resumeTurn),
				accounted: [...draft.state.accounted, ...event.knownEntryIds],
			};
			break;

		case "poll":
			handlePoll(draft, event);
			break;

		case "agentStart":
			draft.state = { ...draft.state, streaming: true };
			if (draft.state.promptDepth === 0 && draft.state.phase !== "running") {
				writePhase(draft, "running", event.now);
			}
			break;

		case "agentSettled":
			handleSettled(draft, event);
			break;

		case "uiPromptStart": {
			const depth = draft.state.promptDepth + 1;
			draft.state = { ...draft.state, promptDepth: depth };
			if (depth === 1) writePhase(draft, "blocked", event.now);
			break;
		}

		case "uiPromptEnd": {
			const depth = Math.max(0, draft.state.promptDepth - 1);
			draft.state = { ...draft.state, promptDepth: depth };
			if (depth === 0) {
				const next: BeaconPhase =
					draft.state.streaming || draft.state.pending.length > 0 ? "running" : "idle";
				writePhase(draft, next, event.now);
			}
			break;
		}

		case "sessionShutdown":
			draft.state = { ...draft.state, quitting: true };
			writePhase(draft, "closed", event.now);
			break;
	}

	return { state: draft.state, effects: draft.effects };
}
