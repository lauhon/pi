/**
 * Named fixture shapes shared by the tests, generate.ts and the conformance test.
 * Each builder exercises one structure the analyzer must handle. Keep them small.
 */
import { SessionBuilder, defaultSections, defaultTools } from "./build.ts";

export type ShapeName = keyof typeof SHAPES;

/** Two plain turns, the second with one tool call: the baseline every other shape extends. */
export function linear(): SessionBuilder {
	const b = new SessionBuilder({ id: "linear" });
	b.system();
	b.user("What does the loader do?");
	b.assistant({ text: "It parses session files.", usage: { input: 2000, output: 40 } });
	b.user("Read the file and tell me.");
	b.toolTurn("read", { path: "/repo/src/load.ts" }, "export function loadSession() {}", { usage: { input: 2100, cacheRead: 1900 } });
	b.assistant({ text: "The loader reads the file.", usage: { input: 2300, cacheRead: 2000 } });
	return b;
}

/** A fork: the user rewinds to the first turn and continues on a new branch. */
export function fork(): SessionBuilder {
	const b = new SessionBuilder({ id: "fork" });
	b.system();
	b.user("First question");
	const firstAnswer = b.assistant({ text: "First answer" });
	b.user("Abandoned follow-up");
	b.assistant({ text: "Abandoned answer" });
	b.branchFrom(firstAnswer);
	b.user("Second question on the new branch");
	b.assistant({ text: "Second answer" });
	return b;
}

/** A rewind with a branch summary (pi's /tree navigation). */
export function rewindWithSummary(): SessionBuilder {
	const b = new SessionBuilder({ id: "rewind-summary" });
	b.system();
	const firstUser = b.user("Try approach A");
	b.assistant({ text: "Trying A" });
	const abandonedLeaf = b.assistant({ text: "A failed" });
	b.branchFrom(firstUser);
	b.branchSummary(abandonedLeaf, "Approach A failed because of X.");
	b.user("Try approach B");
	b.assistant({ text: "B works" });
	return b;
}

/** A compaction that keeps the last turn, with a system checkpoint. */
export function compaction(): SessionBuilder {
	const b = new SessionBuilder({ id: "compaction" });
	b.system();
	b.user("Turn one");
	b.toolTurn("read", { path: "/repo/a.ts" }, "contents of a", { usage: { input: 50_000 } });
	b.assistant({ text: "Done with one", usage: { input: 60_000 } });
	const keptUser = b.user("Turn two");
	b.assistant({ text: "Done with two", usage: { input: 70_000 } });
	b.compaction({ summary: "Turn one read a.ts.", firstKeptEntryId: keptUser, tokensBefore: 70_000, systemMessage: true });
	b.user("Turn three, after compaction");
	b.toolTurn("read", { path: "/repo/a.ts" }, "contents of a", { usage: { input: 9_000 } });
	b.assistant({ text: "Read it again", usage: { input: 9_500 } });
	return b;
}

/** A retain-none compaction (firstKeptEntryId = own id) without a system checkpoint (older pi). */
export function compactionRetainNone(): SessionBuilder {
	const b = new SessionBuilder({ id: "compaction-retain-none" });
	b.system();
	b.user("Turn one");
	b.assistant({ text: "Answer one" });
	b.compaction({ summary: "Everything so far.", firstKeptEntryId: null, tokensBefore: 30_000 });
	b.user("Turn two");
	b.assistant({ text: "Answer two" });
	return b;
}

/** Extension injections: a custom_message in context, a custom entry out of it, a bash execution. */
export function injections(): SessionBuilder {
	const b = new SessionBuilder({ id: "injections" });
	b.system();
	b.custom("subagents-monitor", { runs: 1 });
	b.user("Start the work");
	b.assistant({ text: "Working", toolCalls: [{ name: "bash", args: { command: "sub spawn worker" } }] });
	b.toolResult({ callId: "call_1", name: "bash", text: "spawned: worker" });
	b.customMessage("subagents-monitor", "Child worker finished: out-1.md");
	b.assistant({ text: "The child finished." });
	b.bashExecution("git status", "clean");
	b.user("Thanks");
	b.assistant({ text: "Done." });
	return b;
}

/** Tool errors: a missing path, an immediate identical retry, then a different path that works. */
export function toolErrors(): SessionBuilder {
	const b = new SessionBuilder({ id: "tool-errors" });
	b.system();
	b.user("Read the ADR");
	b.toolTurn("read", { path: "/repo/docs/adr-001.md" }, "ENOENT: no such file or directory, open '/repo/docs/adr-001.md'", { isError: true });
	b.toolTurn("read", { path: "/repo/docs/adr-001.md" }, "ENOENT: no such file or directory, open '/repo/docs/adr-001.md'", { isError: true });
	b.toolTurn("bash", { command: "ls /repo/docs" }, "0001-record.md");
	b.toolTurn("read", { path: "/repo/docs/0001-record.md" }, "# ADR 1");
	b.assistant({ text: "Found it under docs/0001-record.md." });
	return b;
}

/** A read, then an edit of the same file, then another request: the read result is stale. */
export function staleRead(): SessionBuilder {
	const b = new SessionBuilder({ id: "stale-read" });
	b.system();
	b.user("Rename the function");
	b.toolTurn("read", { path: "/repo/src/a.ts" }, "export function old() {}");
	b.toolTurn("edit", { path: "/repo/src/a.ts", oldText: "old", newText: "renamed" }, "Edited /repo/src/a.ts");
	b.assistant({ text: "Renamed." });
	b.user("Now check it");
	b.toolTurn("bash", { command: "npm test" }, "1 passed");
	b.assistant({ text: "Tests pass." });
	return b;
}

/** A context edit that omits one tool result and replaces a user message. */
export function contextEdit(): SessionBuilder {
	const b = new SessionBuilder({ id: "context-edit" });
	b.system();
	const user = b.user("Read something big");
	const { resultId } = b.toolTurn("read", { path: "/repo/big.log" }, "x".repeat(5000));
	b.assistant({ text: "Read it." });
	b.contextEdit(resultId, null);
	b.contextEdit(user, { content: "Read something big (trimmed)" });
	b.user("Continue");
	b.assistant({ text: "Continuing." });
	return b;
}

/** Model and thinking level changes between turns, plus a system patch removing a section. */
export function modelChange(): SessionBuilder {
	const b = new SessionBuilder({ id: "model-change" });
	b.system();
	b.thinkingLevel("medium");
	b.user("Hello");
	b.assistant({ text: "Hi", model: "gpt-5.6-terra" });
	b.modelChange("github-copilot", "gpt-5.6-sol");
	b.thinkingLevel("high");
	b.system({ sections: { skills: null }, toolsRemoved: ["write"] });
	b.user("Harder question");
	b.assistant({ text: "Deep answer", model: "gpt-5.6-sol", thinkingLevel: "high", thinking: "Let me think.", usage: { input: 3000, output: 500 } });
	return b;
}

/** A session whose first line carries no system message (older pi) and a user message as root. */
export function noSystemMessage(): SessionBuilder {
	const b = new SessionBuilder({ id: "no-system" });
	b.user("Old-style session");
	b.assistant({ text: "Answer" });
	return b;
}

/** A skill loaded both ways: the model reads the listed location, then the user types /skill:. */
export function skillLoad(): SessionBuilder {
	const b = new SessionBuilder({ id: "skill-load" });
	b.system();
	b.user("Open a terminal tab");
	b.toolTurn("read", { path: "/repo/skills/cmux/SKILL.md" }, "# cmux\nUse `cmux send` to run commands.");
	b.assistant({ text: "Loaded the cmux skill." });
	b.user('<skill name="cmux" location="/repo/skills/cmux/SKILL.md">\nReferences are relative to /repo/skills/cmux.\n\n# cmux\nUse `cmux send`.\n</skill>\n\nopen a tab');
	b.assistant({ text: "Opened." });
	return b;
}

/** An extension adds its own prompt section and a free-form system content update. */
export function customSection(): SessionBuilder {
	const b = new SessionBuilder({ id: "custom-section" });
	b.system();
	b.system({ content: "Always answer in German.", sections: { guidelines: "<guidelines>\n- Ask when ambiguous\n</guidelines>" } });
	b.user("Hallo");
	b.assistant({ text: "Hallo!" });
	return b;
}

export const SHAPES = {
	linear,
	fork,
	rewindWithSummary,
	compaction,
	compactionRetainNone,
	injections,
	toolErrors,
	staleRead,
	contextEdit,
	modelChange,
	noSystemMessage,
	skillLoad,
	customSection,
};

export { defaultSections, defaultTools };
