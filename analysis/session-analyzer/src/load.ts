/**
 * file -> Session: header, entries, active branch, turns and request points.
 *
 * The only module that imports pi's package. Parsing and migration use pi's own
 * parseSessionEntries and migrateSessionEntries; the context at a request point is pi's
 * own buildSessionProjection with the leaf set to the assistant entry's parent (D6).
 * The file is read here rather than with pi's loadEntriesFromFile because that function
 * is not exported from the package root and appends a newline to files that lack one.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readSync, openSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	buildSessionProjection,
	migrateSessionEntries,
	parseSessionEntries,
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type ModelChangeEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "@earendil-works/pi-coding-agent";
import { canonicalModel } from "./model.ts";
import type {
	AbandonedBranch,
	CompactionInfo,
	Fork,
	RequestContext,
	RequestPoint,
	RequestUsage,
	Session,
	ToolCallRecord,
	ToolResultRecord,
	Turn,
} from "./types.ts";

export type {
	BranchSummaryEntry,
	CompactionEntry,
	ContextEditEntry,
	CustomEntry,
	CustomMessageEntry,
	FileEntry,
	ModelChangeEntry,
	SessionEntry,
	SessionHeader,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
};
export type UsageEntry = Extract<SessionEntry, { type: "usage" }>;
export type AgentMessage = SessionMessageEntry["message"];
export type SystemMessage = Extract<AgentMessage, { role: "system" }>;
export type UserMessage = Extract<AgentMessage, { role: "user" }>;
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
export type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
export type CustomMessage = Extract<AgentMessage, { role: "custom" }>;
export type BashExecutionMessage = Extract<AgentMessage, { role: "bashExecution" }>;
export type AssistantContent = AssistantMessage["content"][number];
export type ToolCall = Extract<AssistantContent, { type: "toolCall" }>;
export type ToolDeclaration = NonNullable<SystemMessage["toolsAdded"]>[number];

// ── Content helpers (shared by inventory, observables and sanitize) ────────

/** Text of a user, custom, system or tool-result content value; images count as nothing. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

export function assistantText(message: AssistantMessage): string {
	return contentText(message.content);
}

export function assistantThinking(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content ?? []) {
		if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
	}
	return parts.join("\n");
}

export function assistantToolCalls(message: AssistantMessage): ToolCall[] {
	return (message.content ?? []).filter((block): block is ToolCall => block.type === "toolCall");
}

export function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

export function isAssistantEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: AssistantMessage } {
	return entry.type === "message" && entry.message.role === "assistant";
}

export function isUserEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: UserMessage } {
	return entry.type === "message" && entry.message.role === "user";
}

export function isToolResultEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: ToolResultMessage } {
	return entry.type === "message" && entry.message.role === "toolResult";
}

export function isSystemEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: SystemMessage } {
	return entry.type === "message" && entry.message.role === "system";
}

/** JSON with object keys sorted at every level, so equal arguments serialize equally. */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
		return `{${body.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function hashArgs(args: unknown): string {
	return createHash("sha1").update(stableStringify(args)).digest("hex").slice(0, 12);
}

export function toolCallRecord(call: ToolCall): ToolCallRecord {
	const args = (call.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>;
	const path = typeof args.path === "string" ? args.path : undefined;
	return { id: call.id, name: call.name, argsHash: hashArgs(args), ...(path !== undefined ? { path } : {}), args };
}

// ── Loading ────────────────────────────────────────────────────────────────

export interface ParseOptions {
	/**
	 * Keep only entries written at or before this time (ISO 8601). Entries are appended in time
	 * order, so this is the file as it was at that moment: the active branch ends at the last
	 * entry before the cut, and later forks and compactions do not exist yet.
	 */
	until?: string;
}

export function loadSession(path: string, options: ParseOptions = {}): Session {
	return parseSession(readFileSync(path, "utf8"), path, options);
}

/** Pure: parse JSONL content into a Session. Throws when the first line is not a session header. */
export function parseSession(content: string, path: string, options: ParseOptions = {}): Session {
	const fileEntries: FileEntry[] = parseSessionEntries(content);
	const header = fileEntries[0];
	if (!header || header.type !== "session" || typeof header.id !== "string") {
		throw new Error(`${path}: not a pi session file (first line is not a session header)`);
	}
	const version = (header as SessionHeader).version ?? 1;
	migrateSessionEntries(fileEntries);
	const untilMs = options.until === undefined ? undefined : parseTime(options.until, "until");
	const entries = fileEntries.filter(
		(entry): entry is SessionEntry => entry.type !== "session" && (untilMs === undefined || Date.parse(entry.timestamp) <= untilMs),
	);
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	const leafId = entries.length > 0 ? entries[entries.length - 1].id : null;
	const branch = walkToRoot(leafId, byId);

	const { turns, turnOf } = assignTurns(branch);
	const requestPoints = buildRequestPoints(entries, byId, branch, turnOf, turns);
	const forks = findForks(entries, branch, turnOf);

	const entryTypeCounts: Record<string, number> = {};
	const messageRoleCounts: Record<string, number> = {};
	for (const entry of entries) {
		entryTypeCounts[entry.type] = (entryTypeCounts[entry.type] ?? 0) + 1;
		if (entry.type === "message") {
			const role = String(entry.message?.role ?? "unknown");
			messageRoleCounts[role] = (messageRoleCounts[role] ?? 0) + 1;
		}
	}

	const compactions: CompactionInfo[] = branch
		.filter((entry): entry is CompactionEntry => entry.type === "compaction")
		.map((entry) => ({
			id: entry.id,
			turnIndex: turnOf.get(entry.id) ?? 0,
			tokensBefore: entry.tokensBefore ?? 0,
			summaryChars: (entry.summary ?? "").length,
			firstKeptEntryId: entry.firstKeptEntryId,
			hasSystemMessage: entry.systemMessage !== undefined,
			cost: entry.usage?.cost?.total ?? 0,
		}));

	const startedAt = (header as SessionHeader).timestamp ?? entries[0]?.timestamp ?? "";
	const endedAt = entries.length > 0 ? entries[entries.length - 1].timestamp : startedAt;
	const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) || 0;

	return {
		path,
		id: header.id,
		cwd: (header as SessionHeader).cwd ?? "",
		version,
		...(options.until !== undefined ? { window: { until: options.until } } : {}),
		...((header as SessionHeader).parentSession ? { parentSession: (header as SessionHeader).parentSession } : {}),
		entries,
		byId,
		branch,
		leafId,
		turnOf,
		turns,
		requestPoints,
		forks,
		branchSummaryCount: entries.filter((entry) => entry.type === "branch_summary").length,
		compactions,
		entryTypeCounts,
		messageRoleCounts,
		startedAt,
		endedAt,
		durationMs,
	};
}

export function parseTime(value: string, name: string): number {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new Error(`${name}: not a date: ${value}`);
	return ms;
}

function walkToRoot(leafId: string | null, byId: Map<string, SessionEntry>): SessionEntry[] {
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = leafId ? byId.get(leafId) : undefined;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path.reverse();
}

function assignTurns(branch: SessionEntry[]): { turns: Turn[]; turnOf: Map<string, number> } {
	const turnOf = new Map<string, number>();
	const turns: Turn[] = [{ index: 0, userText: "", userChars: 0, startedAt: branch[0]?.timestamp ?? "", requestIndexes: [] }];
	for (const entry of branch) {
		if (isUserEntry(entry)) {
			const userText = contentText(entry.message.content);
			turns.push({
				index: turns.length,
				userEntryId: entry.id,
				userText,
				userChars: userText.length,
				startedAt: entry.timestamp,
				requestIndexes: [],
			});
		}
		turnOf.set(entry.id, turns.length - 1);
	}
	return { turns, turnOf };
}

function buildRequestPoints(
	entries: SessionEntry[],
	byId: Map<string, SessionEntry>,
	branch: SessionEntry[],
	turnOf: Map<string, number>,
	turns: Turn[],
): RequestPoint[] {
	const requestPoints: RequestPoint[] = [];
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (!isAssistantEntry(entry)) continue;
		const message = entry.message;
		const turnIndex = turnOf.get(entry.id) ?? 0;
		const calls = assistantToolCalls(message).map(toolCallRecord);
		const callIds = new Set(calls.map((call) => call.id));
		const toolResults: ToolResultRecord[] = [];
		for (let j = i + 1; j < branch.length; j++) {
			const next = branch[j];
			if (isAssistantEntry(next)) break;
			if (!isToolResultEntry(next)) continue;
			const result = next.message;
			if (!callIds.has(result.toolCallId)) continue;
			const text = contentText(result.content);
			toolResults.push({
				id: result.toolCallId,
				name: result.toolName,
				entryId: next.id,
				chars: text.length,
				isError: result.isError === true,
				text,
			});
		}
		const context = projectContext(entries, entry.parentId, byId);
		const thinkingLevel = message.thinkingLevel ?? thinkingLevelBefore(branch, i);
		const requestPoint: RequestPoint = {
			index: requestPoints.length,
			turnIndex,
			assistantEntryId: entry.id,
			timestamp: entry.timestamp,
			provider: message.provider ?? "",
			model: canonicalModel(message.model ?? ""),
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
			usage: requestUsage(message),
			stopReason: message.stopReason ?? "",
			...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
			textChars: assistantText(message).length,
			thinkingChars: assistantThinking(message).length,
			toolCalls: calls,
			toolResults,
			context,
		};
		requestPoints.push(requestPoint);
		turns[turnIndex].requestIndexes.push(requestPoint.index);
	}
	return requestPoints;
}

function thinkingLevelBefore(branch: SessionEntry[], index: number): string | undefined {
	for (let i = index - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "thinking_level_change") return entry.thinkingLevel;
	}
	return undefined;
}

function requestUsage(message: AssistantMessage): RequestUsage {
	const usage = message.usage;
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const cacheWrite = usage?.cacheWrite ?? 0;
	return { input, output, cacheRead, cacheWrite, cost: usage?.cost?.total ?? 0, contextTokens: input + cacheRead + cacheWrite };
}

/** pi's projection with the leaf at the assistant entry's parent: exactly the entries the request was built from. */
export function projectContext(entries: SessionEntry[], leafId: string | null, byId: Map<string, SessionEntry>): RequestContext {
	const projection = buildSessionProjection(entries, leafId, byId);
	const messages: AgentMessage[] = [];
	const sourceEntryIds: string[] = [];
	for (const projected of projection.entries) {
		for (const message of projected.messages) {
			messages.push(message);
			sourceEntryIds.push(projected.sourceEntry.id);
		}
	}
	return { entries: projection.entries.map((projected) => projected.sourceEntry), messages, sourceEntryIds };
}

function findForks(entries: SessionEntry[], branch: SessionEntry[], turnOf: Map<string, number>): Fork[] {
	const children = new Map<string | null, SessionEntry[]>();
	for (const entry of entries) {
		const list = children.get(entry.parentId) ?? [];
		list.push(entry);
		children.set(entry.parentId, list);
	}
	const onBranch = new Set(branch.map((entry) => entry.id));
	const forks: Fork[] = [];
	for (const [parentId, kids] of children) {
		if (kids.length < 2) continue;
		const abandoned: AbandonedBranch[] = kids
			.filter((kid) => !onBranch.has(kid.id))
			.map((kid) => subtreeStats(kid, children));
		forks.push({
			parentId,
			turnIndex: parentId ? (turnOf.get(parentId) ?? 0) : 0,
			childIds: kids.map((kid) => kid.id),
			abandoned,
		});
	}
	forks.sort((a, b) => a.turnIndex - b.turnIndex);
	return forks;
}

function subtreeStats(head: SessionEntry, children: Map<string | null, SessionEntry[]>): AbandonedBranch {
	let entryCount = 0;
	let assistantCount = 0;
	const stack = [head];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const entry = stack.pop()!;
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		entryCount++;
		if (isAssistantEntry(entry)) assistantCount++;
		for (const kid of children.get(entry.id) ?? []) stack.push(kid);
	}
	return { headId: head.id, entryCount, assistantCount };
}

// ── Discovery ──────────────────────────────────────────────────────────────

const SKIPPED_DIRS = new Set(["node_modules", ".git"]);

/** Every pi session file under dir, recursively, sorted by path. Non-session .jsonl files are skipped. */
export function findSessionFiles(dir: string): string[] {
	const found: string[] = [];
	const visit = (current: string) => {
		let names: string[];
		try {
			names = readdirSync(current);
		} catch {
			return;
		}
		for (const name of names.sort()) {
			const full = join(current, name);
			let info;
			try {
				info = statSync(full);
			} catch {
				continue;
			}
			if (info.isDirectory()) {
				if (!SKIPPED_DIRS.has(name)) visit(full);
			} else if (name.endsWith(".jsonl") && looksLikeSession(full)) {
				found.push(full);
			}
		}
	};
	const root = statSync(dir);
	if (root.isFile()) return [dir];
	visit(dir);
	return found;
}

function looksLikeSession(path: string): boolean {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(256);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		return /^\s*\{\s*"type"\s*:\s*"session"/.test(buffer.toString("utf8", 0, read));
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

// ── System message replay ──────────────────────────────────────────────────

export interface SystemState {
	/** Section text by name after replaying every system message in order (null patches remove). */
	sections: Map<string, { text: string; entryId: string; position: number }>;
	/** Tool declarations in force, keyed by name, with the message that last added each. */
	tools: Map<string, { tool: ToolDeclaration; entryId: string; position: number }>;
	/** Free-form `content` text of every system message, in order. */
	content: { text: string; entryId: string; position: number }[];
}

/**
 * Replay the system messages of a context into the prompt state the model saw, the way
 * pi-ai's getCurrentSystemMessage does: later `sections` patch by name, null removes,
 * toolsRemoved then toolsAdded apply in order. Kept here, next to the other message
 * helpers, so inventory.ts stays free of pi's rules.
 */
export function replaySystemMessages(messages: AgentMessage[], sourceEntryIds: string[]): SystemState {
	const state: SystemState = { sections: new Map(), tools: new Map(), content: [] };
	messages.forEach((message, position) => {
		if (message.role !== "system") return;
		const entryId = sourceEntryIds[position] ?? "";
		const text = contentText(message.content);
		if (text.length > 0) state.content.push({ text, entryId, position });
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) state.sections.delete(name);
			else state.sections.set(name, { text: value, entryId, position });
		}
		for (const tool of message.toolsRemoved ?? []) state.tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) state.tools.set(tool.name, { tool, entryId, position });
	});
	return state;
}
