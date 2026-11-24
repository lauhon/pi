/**
 * Fixture builder: writes synthetic pi session JSONL (version 3) with a chosen shape.
 *
 * Ids are `e1`, `e2`, ... in append order and timestamps advance one second per entry,
 * so output is deterministic. `branchFrom(id)` moves the leaf, as pi's branch() does, so
 * the next append forks. Shapes used by the tests live in shapes.ts; generate.ts writes
 * them to disk for the CLI and the conformance test.
 */
import type { FileEntry, ToolDeclaration } from "../src/load.ts";

/** Raw JSON entry for tests that poke at fields. */
export type RawEntry = Record<string, any>;

export interface ToolCallSpec {
	id?: string;
	name: string;
	args: Record<string, unknown>;
}

export interface UsageSpec {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
}

export interface AssistantSpec {
	text?: string;
	thinking?: string;
	toolCalls?: ToolCallSpec[];
	provider?: string;
	model?: string;
	usage?: UsageSpec;
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
	thinkingLevel?: string;
	errorMessage?: string;
}

export interface SystemSpec {
	content?: string;
	sections?: Record<string, string | null>;
	tools?: ToolDeclaration[];
	toolsRemoved?: string[];
}

export interface ToolResultSpec {
	callId: string;
	name: string;
	text: string;
	isError?: boolean;
	details?: unknown;
}

export interface CompactionSpec {
	summary: string;
	/** null stores the compaction's own id (retain none), as pi does. */
	firstKeptEntryId: string | null;
	tokensBefore: number;
	/** true: checkpoint the current replayed system state; an object: store it verbatim. */
	systemMessage?: boolean | Record<string, unknown>;
	usage?: UsageSpec;
}

export interface BuilderOptions {
	id?: string;
	cwd?: string;
	startedAt?: string;
	parentSession?: string;
}

export const DEFAULT_PROVIDER = "github-copilot";
export const DEFAULT_MODEL = "gpt-5.6-terra";

export function toolDeclaration(name: string, description = `${name} tool`, params: string[] = ["path"]): ToolDeclaration {
	const properties: Record<string, unknown> = {};
	for (const param of params) properties[param] = { type: "string", description: `${param} argument` };
	return { name, description, parameters: { type: "object", properties, required: params } as ToolDeclaration["parameters"] };
}

export function defaultTools(): ToolDeclaration[] {
	return [
		toolDeclaration("read", "Read the contents of a file.", ["path", "offset", "limit"]),
		toolDeclaration("bash", "Execute a bash command.", ["command", "timeout"]),
		toolDeclaration("edit", "Edit a file using exact text replacement.", ["path", "oldText", "newText"]),
		toolDeclaration("write", "Write a file.", ["path", "content"]),
	];
}

export function defaultSections(cwd = "/repo"): Record<string, string> {
	return {
		preamble: "You are an expert coding assistant operating inside pi.",
		tools: "<tools>\n- read: read a file\n- bash: run a command\n- edit: edit a file\n- write: write a file\n</tools>",
		rules: "<rules>\n- Be concise in your responses\n</rules>",
		project_context: `<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${cwd}/AGENTS.md">\n# Rules\n- Ask before git commands\n</project_instructions>\n</project_context>`,
		skills: `<skills>\n<available_skills>\n  <skill>\n    <name>cmux</name>\n    <description>Terminal multiplexer usage</description>\n    <location>${cwd}/skills/cmux/SKILL.md</location>\n  </skill>\n</available_skills>\n</skills>`,
		cwd: `<cwd>\n${cwd}\n</cwd>`,
	};
}

export class SessionBuilder {
	private readonly entries: FileEntry[] = [];
	private readonly sessionId: string;
	private readonly cwd: string;
	private readonly t0: number;
	private counter = 0;
	private leafId: string | null = null;
	private callCounter = 0;
	private sections = new Map<string, string>();
	private tools = new Map<string, ToolDeclaration>();

	constructor(options: BuilderOptions = {}) {
		this.sessionId = options.id ?? "fixture-session";
		this.cwd = options.cwd ?? "/repo";
		this.t0 = Date.parse(options.startedAt ?? "2026-08-01T10:00:00.000Z");
		this.entries.push({
			type: "session",
			version: 3,
			id: this.sessionId,
			timestamp: new Date(this.t0).toISOString(),
			cwd: this.cwd,
			...(options.parentSession ? { parentSession: options.parentSession } : {}),
		});
	}

	getCwd(): string {
		return this.cwd;
	}

	getLeafId(): string | null {
		return this.leafId;
	}

	/** Move the leaf, so the next append starts a branch (pi's branch()). null makes a new root. */
	branchFrom(id: string | null): void {
		this.leafId = id;
	}

	private append(entry: Record<string, unknown>): string {
		this.counter++;
		const id = `e${this.counter}`;
		const timestamp = new Date(this.t0 + this.counter * 1000).toISOString();
		this.entries.push({ ...(entry as object), id, parentId: this.leafId, timestamp } as unknown as FileEntry);
		this.leafId = id;
		return id;
	}

	private messageTimestamp(): number {
		return this.t0 + (this.counter + 1) * 1000;
	}

	system(spec: SystemSpec = {}): string {
		const sections = spec.sections ?? (this.counter === 0 ? defaultSections(this.cwd) : undefined);
		const tools = spec.tools ?? (this.counter === 0 ? defaultTools() : undefined);
		for (const [name, value] of Object.entries(sections ?? {})) {
			if (value === null) this.sections.delete(name);
			else this.sections.set(name, value);
		}
		for (const name of spec.toolsRemoved ?? []) this.tools.delete(name);
		for (const tool of tools ?? []) this.tools.set(tool.name, tool);
		return this.append({
			type: "message",
			message: {
				role: "system",
				content: spec.content ?? "",
				...(sections ? { sections } : {}),
				...(tools ? { toolsAdded: tools } : {}),
				...(spec.toolsRemoved ? { toolsRemoved: spec.toolsRemoved.map((name) => ({ name })) } : {}),
				timestamp: this.messageTimestamp(),
			},
		});
	}

	user(content: string | unknown[]): string {
		return this.append({ type: "message", message: { role: "user", content, timestamp: this.messageTimestamp() } });
	}

	assistant(spec: AssistantSpec = {}): string {
		const content: unknown[] = [];
		if (spec.thinking !== undefined) content.push({ type: "thinking", thinking: spec.thinking });
		if (spec.text !== undefined) content.push({ type: "text", text: spec.text });
		for (const call of spec.toolCalls ?? []) {
			content.push({ type: "toolCall", id: call.id ?? this.nextCallId(), name: call.name, arguments: call.args });
		}
		const usage = fullUsage(spec.usage);
		return this.append({
			type: "message",
			message: {
				role: "assistant",
				content,
				api: "openai-responses",
				provider: spec.provider ?? DEFAULT_PROVIDER,
				model: spec.model ?? DEFAULT_MODEL,
				...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
				usage,
				stopReason: spec.stopReason ?? ((spec.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop"),
				...(spec.errorMessage ? { errorMessage: spec.errorMessage } : {}),
				timestamp: this.messageTimestamp(),
			},
		});
	}

	nextCallId(): string {
		this.callCounter++;
		return `call_${this.callCounter}`;
	}

	/** The id the next tool call will get, for specs that need to name it before appending. */
	peekCallId(): string {
		return `call_${this.callCounter + 1}`;
	}

	toolResult(spec: ToolResultSpec): string {
		return this.append({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: spec.callId,
				toolName: spec.name,
				content: [{ type: "text", text: spec.text }],
				...(spec.details !== undefined ? { details: spec.details } : {}),
				isError: spec.isError === true,
				timestamp: this.messageTimestamp(),
			},
		});
	}

	/** One assistant message calling one tool, followed by its result. Returns both ids. */
	toolTurn(
		name: string,
		args: Record<string, unknown>,
		resultText: string,
		options: { isError?: boolean; text?: string; usage?: UsageSpec; model?: string; provider?: string } = {},
	): { callId: string; assistantId: string; resultId: string } {
		const callId = this.nextCallId();
		const assistantId = this.assistant({
			text: options.text,
			toolCalls: [{ id: callId, name, args }],
			usage: options.usage,
			model: options.model,
			provider: options.provider,
		});
		const resultId = this.toolResult({ callId, name, text: resultText, isError: options.isError });
		return { callId, assistantId, resultId };
	}

	compaction(spec: CompactionSpec): string {
		const id = `e${this.counter + 1}`;
		let systemMessage: Record<string, unknown> | undefined;
		if (spec.systemMessage === true) {
			systemMessage = {
				role: "system",
				content: "",
				sections: Object.fromEntries(this.sections),
				toolsAdded: [...this.tools.values()],
				timestamp: this.messageTimestamp(),
			};
		} else if (spec.systemMessage && typeof spec.systemMessage === "object") {
			systemMessage = spec.systemMessage;
		}
		return this.append({
			type: "compaction",
			summary: spec.summary,
			firstKeptEntryId: spec.firstKeptEntryId ?? id,
			tokensBefore: spec.tokensBefore,
			...(spec.usage ? { usage: fullUsage(spec.usage) } : {}),
			...(systemMessage ? { systemMessage } : {}),
		});
	}

	branchSummary(fromId: string, summary: string): string {
		return this.append({ type: "branch_summary", fromId, summary });
	}

	custom(customType: string, data?: unknown): string {
		return this.append({ type: "custom", customType, ...(data !== undefined ? { data } : {}) });
	}

	customMessage(customType: string, content: string | unknown[], display = true): string {
		return this.append({ type: "custom_message", customType, content, display });
	}

	bashExecution(command: string, output: string, exitCode = 0): string {
		return this.append({
			type: "message",
			message: { role: "bashExecution", command, output, exitCode, cancelled: false, truncated: false, timestamp: this.messageTimestamp() },
		});
	}

	modelChange(provider: string, modelId: string): string {
		return this.append({ type: "model_change", provider, modelId });
	}

	thinkingLevel(level: string): string {
		return this.append({ type: "thinking_level_change", thinkingLevel: level });
	}

	contextEdit(targetId: string, replacement: { content: unknown } | null): string {
		return this.append({ type: "context_edit", targetId, replacement });
	}

	label(targetId: string, label: string | undefined): string {
		return this.append({ type: "label", targetId, label });
	}

	sessionInfo(name: string): string {
		return this.append({ type: "session_info", name });
	}

	usage(kind: string, provider: string, model: string, usage: UsageSpec): string {
		return this.append({ type: "usage", kind, provider, model, usage: fullUsage(usage) });
	}

	/** A deep copy of the entries as raw JSON, for tests that poke at fields. */
	toEntries(): RawEntry[] {
		return JSON.parse(`[${this.entries.map((entry) => JSON.stringify(entry)).join(",")}]`) as RawEntry[];
	}

	toJsonl(): string {
		return `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	}
}

export function fullUsage(spec: UsageSpec = {}): Record<string, unknown> {
	const input = spec.input ?? 1000;
	const output = spec.output ?? 100;
	const cacheRead = spec.cacheRead ?? 0;
	const cacheWrite = spec.cacheWrite ?? 0;
	const total = spec.cost ?? Number(((input * 3 + output * 15 + cacheRead * 0.3 + cacheWrite * 3.75) / 1_000_000).toFixed(6));
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}
