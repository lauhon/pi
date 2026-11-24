/**
 * Sanitize a session for use as a committed fixture.
 *
 * Keeps structure, ids, parent links, timestamps, usage, models, stop reasons, tool names,
 * paths, section names, parameter schemas and text sizes. Replaces every free-text body
 * with a same-length placeholder that keeps line breaks: user and assistant text, thinking,
 * tool arguments other than paths, tool results, system prompt sections and tool
 * descriptions, compaction and branch summaries, custom messages, labels and names.
 * Drops provider signatures, image data, extension `data` and tool-result `details`
 * (except `truncation`), since none of those carry a measured quantity.
 */
import type { FileEntry } from "./load.ts";

const KEEP_ARG_KEYS = new Set(["path", "offset", "limit", "timeout"]);
const SCHEMA_TEXT_KEYS = new Set(["description", "title", "default", "examples", "enum", "const", "pattern"]);

export function placeholder(text: string): string {
	return text.replace(/[^\n]/g, "x");
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeContent(content: unknown): unknown {
	if (typeof content === "string") return placeholder(content);
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (!isObject(block)) return block;
		switch (block.type) {
			case "text":
				return { type: "text", text: placeholder(String(block.text ?? "")) };
			case "thinking":
				return { type: "thinking", thinking: placeholder(String(block.thinking ?? "")), ...(block.redacted ? { redacted: true } : {}) };
			case "image":
				return { type: "image", data: "", mimeType: block.mimeType ?? "" };
			case "toolCall":
				return { type: "toolCall", id: block.id, name: block.name, arguments: sanitizeArgs(block.arguments), ...(block.namespace ? { namespace: block.namespace } : {}) };
			default:
				return block;
		}
	});
}

function sanitizeArgs(args: unknown): unknown {
	if (typeof args === "string") return placeholder(args);
	if (Array.isArray(args)) return args.map(sanitizeArgs);
	if (!isObject(args)) return args;
	const out: Json = {};
	for (const [key, value] of Object.entries(args)) {
		if (KEEP_ARG_KEYS.has(key)) out[key] = value;
		else out[key] = sanitizeArgs(value);
	}
	return out;
}

function sanitizeSchema(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(sanitizeSchema);
	if (!isObject(schema)) return schema;
	const out: Json = {};
	for (const [key, value] of Object.entries(schema)) {
		if (SCHEMA_TEXT_KEYS.has(key)) out[key] = sanitizeArgs(value);
		else out[key] = sanitizeSchema(value);
	}
	return out;
}

function sanitizeSystem(message: Json): Json {
	const out: Json = { ...message, content: sanitizeContent(message.content) };
	if (isObject(message.sections)) {
		out.sections = Object.fromEntries(
			Object.entries(message.sections).map(([name, text]) => [name, typeof text === "string" ? placeholder(text) : text]),
		);
	}
	if (Array.isArray(message.toolsAdded)) {
		out.toolsAdded = message.toolsAdded.map((tool) =>
			isObject(tool)
				? { ...tool, description: placeholder(String(tool.description ?? "")), parameters: sanitizeSchema(tool.parameters) }
				: tool,
		);
	}
	return out;
}

function sanitizeMessage(message: unknown): unknown {
	if (!isObject(message)) return message;
	switch (message.role) {
		case "system":
			return sanitizeSystem(message);
		case "user":
			return { ...message, content: sanitizeContent(message.content) };
		case "assistant": {
			const { errorMessage, ...rest } = message;
			return {
				...rest,
				content: sanitizeContent(message.content),
				...(typeof errorMessage === "string" ? { errorMessage: placeholder(errorMessage) } : {}),
			};
		}
		case "toolResult": {
			const { details, ...rest } = message;
			const truncation = isObject(details) && details.truncation !== undefined ? { details: { truncation: details.truncation } } : {};
			return { ...rest, content: sanitizeContent(message.content), ...truncation };
		}
		case "custom": {
			const { details: _details, ...rest } = message;
			return { ...rest, content: sanitizeContent(message.content) };
		}
		case "bashExecution":
			return { ...message, command: placeholder(String(message.command ?? "")), output: placeholder(String(message.output ?? "")) };
		default:
			return message;
	}
}

function sanitizeEntry(entry: Json): Json {
	switch (entry.type) {
		case "message":
			return { ...entry, message: sanitizeMessage(entry.message) };
		case "compaction": {
			const { details, systemMessage, ...rest } = entry;
			const keptDetails =
				isObject(details) && Object.keys(details).every((key) => key === "readFiles" || key === "modifiedFiles") ? { details } : {};
			return {
				...rest,
				summary: placeholder(String(entry.summary ?? "")),
				...keptDetails,
				...(isObject(systemMessage) ? { systemMessage: sanitizeSystem(systemMessage) } : {}),
			};
		}
		case "branch_summary": {
			const { details: _details, ...rest } = entry;
			return { ...rest, summary: placeholder(String(entry.summary ?? "")) };
		}
		case "custom": {
			const { data: _data, ...rest } = entry;
			return rest;
		}
		case "custom_message": {
			const { details: _details, ...rest } = entry;
			return { ...rest, content: sanitizeContent(entry.content) };
		}
		case "context_edit": {
			const replacement = entry.replacement;
			return { ...entry, replacement: isObject(replacement) ? { content: sanitizeContent(replacement.content) } : replacement };
		}
		case "label":
			return { ...entry, label: typeof entry.label === "string" ? placeholder(entry.label) : entry.label };
		case "session_info":
			return { ...entry, name: typeof entry.name === "string" ? placeholder(entry.name) : entry.name };
		default:
			return entry;
	}
}

/** Pure: sanitized copies of the entries, header included. */
export function sanitizeEntries(entries: FileEntry[]): FileEntry[] {
	return entries.map((entry) => sanitizeEntry(entry as unknown as Json) as unknown as FileEntry);
}

export function sanitizeJsonl(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isObject(parsed)) continue;
		out.push(JSON.stringify(sanitizeEntry(parsed)));
	}
	return `${out.join("\n")}\n`;
}
