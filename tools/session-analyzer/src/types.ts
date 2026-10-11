/**
 * Data contract for the session analyzer (spec-session-analyzer.md, "Data contract").
 *
 * Everything after load.ts takes these plain shapes. The pi entry and message types are
 * re-exported from load.ts so that load.ts stays the only module naming pi's package.
 */
import type { AgentMessage, SessionEntry } from "./load.ts";

export interface RequestUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** `usage.cost.total` of the assistant message, in USD. */
	cost: number;
	/** input + cacheRead + cacheWrite: the context the model was given for this request. */
	contextTokens: number;
}

export interface ToolCallRecord {
	id: string;
	name: string;
	/** Hash of the arguments with keys sorted, so identical calls compare equal. */
	argsHash: string;
	/** `arguments.path` when it is a string (read, edit, write, ls, find, grep). */
	path?: string;
	args: Record<string, unknown>;
}

export interface ToolResultRecord {
	id: string;
	name: string;
	entryId: string;
	chars: number;
	isError: boolean;
	text: string;
}

/** pi's projection of the context for one request: the selected entries and the messages they produce. */
export interface RequestContext {
	entries: SessionEntry[];
	messages: AgentMessage[];
	/** `sourceEntryIds[i]` is the id of the entry that produced `messages[i]`. */
	sourceEntryIds: string[];
}

export interface RequestPoint {
	index: number;
	turnIndex: number;
	assistantEntryId: string;
	timestamp: string;
	provider: string;
	model: string;
	thinkingLevel?: string;
	usage: RequestUsage;
	stopReason: string;
	errorMessage?: string;
	/** Visible text characters (text blocks) in the assistant message. */
	textChars: number;
	/** Thinking characters persisted in the assistant message. */
	thinkingChars: number;
	toolCalls: ToolCallRecord[];
	/** Results answering this request's tool calls, in branch order. */
	toolResults: ToolResultRecord[];
	context: RequestContext;
}

/** A turn starts at every user message on the active branch; turn 0 holds entries before the first one. */
export interface Turn {
	index: number;
	userEntryId?: string;
	userText: string;
	userChars: number;
	startedAt: string;
	requestIndexes: number[];
}

export interface AbandonedBranch {
	/** First entry of the abandoned branch. */
	headId: string;
	entryCount: number;
	assistantCount: number;
}

export interface Fork {
	/** Entry both branches continue from; null when the session has several roots. */
	parentId: string | null;
	turnIndex: number;
	childIds: string[];
	abandoned: AbandonedBranch[];
}

export interface CompactionInfo {
	id: string;
	turnIndex: number;
	tokensBefore: number;
	summaryChars: number;
	firstKeptEntryId: string;
	hasSystemMessage: boolean;
	cost: number;
}

export interface Session {
	path: string;
	id: string;
	cwd: string;
	version: number;
	parentSession?: string;
	entries: SessionEntry[];
	byId: Map<string, SessionEntry>;
	/** Root-to-leaf path of the active branch; the leaf is the last entry in the file, as pi resumes it. */
	branch: SessionEntry[];
	leafId: string | null;
	/** Turn index of every entry on the active branch. */
	turnOf: Map<string, number>;
	turns: Turn[];
	requestPoints: RequestPoint[];
	forks: Fork[];
	branchSummaryCount: number;
	compactions: CompactionInfo[];
	entryTypeCounts: Record<string, number>;
	messageRoleCounts: Record<string, number>;
	startedAt: string;
	endedAt: string;
	durationMs: number;
}
