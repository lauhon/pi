import { describe, expect, it } from "vitest";
import { SessionBuilder } from "../fixtures/build.ts";
import { SHAPES } from "../fixtures/shapes.ts";
import { parseSession } from "./load.ts";
import { placeholder, sanitizeJsonl } from "./sanitize.ts";

type Json = Record<string, any>;

function parseLines(jsonl: string): Json[] {
	return jsonl.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json);
}

describe("placeholder", () => {
	it("keeps length and line breaks only", () => {
		expect(placeholder("ab\ncd")).toBe("xx\nxx");
		expect(placeholder("")).toBe("");
		expect(placeholder("héllo wörld")).toHaveLength("héllo wörld".length);
	});
});

describe("sanitizeJsonl", () => {
	for (const [name, build] of Object.entries(SHAPES)) {
		it(`${name}: keeps structure, ids, usage, names and paths; replaces text`, () => {
			const original = build().toJsonl();
			const sanitized = sanitizeJsonl(original);
			const before = parseLines(original);
			const after = parseLines(sanitized);
			expect(after).toHaveLength(before.length);
			before.forEach((entry, i) => {
				const copy = after[i];
				expect(copy.type).toBe(entry.type);
				expect(copy.id).toBe(entry.id);
				expect(copy.parentId).toBe(entry.parentId);
				expect(copy.timestamp).toBe(entry.timestamp);
				if (entry.type !== "message") return;
				const message = entry.message as Json;
				const copyMessage = copy.message as Json;
				expect(copyMessage.role).toBe(message.role);
				if (message.role === "assistant") {
					expect(copyMessage.usage).toEqual(message.usage);
					expect(copyMessage.model).toBe(message.model);
					expect(copyMessage.stopReason).toBe(message.stopReason);
					(message.content as Json[]).forEach((block, j) => {
						const copyBlock = (copyMessage.content as Json[])[j];
						if (block.type === "text") expect(copyBlock.text).toBe(placeholder(block.text));
						if (block.type === "toolCall") {
							expect(copyBlock.name).toBe(block.name);
							expect(copyBlock.id).toBe(block.id);
							if (block.arguments.path !== undefined) expect(copyBlock.arguments.path).toBe(block.arguments.path);
							if (block.arguments.command !== undefined) expect(copyBlock.arguments.command).toBe(placeholder(block.arguments.command));
						}
					});
				}
				if (message.role === "toolResult") {
					expect(copyMessage.toolName).toBe(message.toolName);
					expect(copyMessage.isError).toBe(message.isError);
					expect(copyMessage.content[0].text).toBe(placeholder(message.content[0].text));
				}
				if (message.role === "system") {
					expect(Object.keys(copyMessage.sections ?? {})).toEqual(Object.keys(message.sections ?? {}));
					for (const [key, text] of Object.entries(message.sections ?? {})) {
						expect(copyMessage.sections[key]).toBe(typeof text === "string" ? placeholder(text) : text);
					}
					(message.toolsAdded ?? []).forEach((tool: Json, j: number) => {
						expect(copyMessage.toolsAdded[j].name).toBe(tool.name);
						expect(copyMessage.toolsAdded[j].description).toBe(placeholder(tool.description));
						expect(Object.keys(copyMessage.toolsAdded[j].parameters.properties)).toEqual(Object.keys(tool.parameters.properties));
					});
				}
			});
			const parsedBefore = parseSession(original, "a.jsonl");
			const parsedAfter = parseSession(sanitized, "b.jsonl");
			expect(parsedAfter.requestPoints.map((rp) => rp.turnIndex)).toEqual(parsedBefore.requestPoints.map((rp) => rp.turnIndex));
			expect(parsedAfter.requestPoints.map((rp) => rp.usage)).toEqual(parsedBefore.requestPoints.map((rp) => rp.usage));
			expect(parsedAfter.requestPoints.map((rp) => rp.textChars)).toEqual(parsedBefore.requestPoints.map((rp) => rp.textChars));
			expect(parsedAfter.requestPoints.map((rp) => rp.toolResults.map((r) => r.chars))).toEqual(parsedBefore.requestPoints.map((rp) => rp.toolResults.map((r) => r.chars)));
			expect(parsedAfter.compactions).toEqual(parsedBefore.compactions);
			expect(parsedAfter.forks).toEqual(parsedBefore.forks);
			expect(sanitizeJsonl(sanitized)).toBe(sanitized);
		});
	}

	it("keeps path-only tool calls hash-equal and changes hashes of calls with text arguments", () => {
		const session = parseSession(sanitizeJsonl(SHAPES.staleRead().toJsonl()), "s.jsonl");
		const original = parseSession(SHAPES.staleRead().toJsonl(), "o.jsonl");
		const read = original.requestPoints[0].toolCalls[0];
		const edit = original.requestPoints[1].toolCalls[0];
		expect(session.requestPoints[0].toolCalls[0].argsHash).toBe(read.argsHash);
		expect(session.requestPoints[1].toolCalls[0].argsHash).not.toBe(edit.argsHash);
		expect(session.requestPoints[1].toolCalls[0].path).toBe("/repo/src/a.ts");
	});

	it("drops signatures, image data, custom data and tool-result details", () => {
		const b = new SessionBuilder({ id: "private" });
		b.system();
		b.custom("ext", { secret: "state" });
		b.user([{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
		b.assistant({ text: "ok", thinking: "hmm" });
		const entries = b.toEntries();
		entries[4].message.content[0].thinkingSignature = "sig";
		entries[4].message.content[1].textSignature = "sig";
		entries[3].message.content.push({ type: "text", text: "more" });
		const jsonl = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const b2 = new SessionBuilder({ id: "details" });
		b2.user("x");
		b2.toolTurn("read", { path: "/p" }, "body");
		const detailEntries = b2.toEntries();
		detailEntries[3].message.details = { diff: "secret", truncation: { truncated: true } };
		const after = parseLines(sanitizeJsonl(jsonl));
		expect(after[2].data).toBeUndefined();
		expect(after[2].customType).toBe("ext");
		expect(after[3].message.content[1]).toEqual({ type: "image", data: "", mimeType: "image/png" });
		expect(after[3].message.content[2].text).toBe("xxxx");
		expect(after[4].message.content[0]).toEqual({ type: "thinking", thinking: "xxx" });
		expect(after[4].message.content[1]).toEqual({ type: "text", text: "xx" });
		const afterDetails = parseLines(sanitizeJsonl(`${detailEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`));
		expect(afterDetails[3].message.details).toEqual({ truncation: { truncated: true } });
	});

	it("keeps compaction file lists, replaces summaries and sanitizes the checkpoint", () => {
		const b = new SessionBuilder({ id: "comp" });
		b.system();
		b.user("a");
		b.assistant({ text: "b" });
		b.compaction({ summary: "sum\nmary", firstKeptEntryId: null, tokensBefore: 10, systemMessage: true });
		const entries = b.toEntries();
		entries[4].details = { readFiles: ["/a"], modifiedFiles: [] };
		const after = parseLines(sanitizeJsonl(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`));
		expect(after[4].summary).toBe("xxx\nxxxx");
		expect(after[4].details).toEqual({ readFiles: ["/a"], modifiedFiles: [] });
		expect(after[4].tokensBefore).toBe(10);
		expect(Object.keys(after[4].systemMessage.sections)).toEqual(Object.keys(entries[4].systemMessage.sections));
		expect(after[4].systemMessage.sections.cwd).toBe(placeholder(entries[4].systemMessage.sections.cwd));
	});
});
