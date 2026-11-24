import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionBuilder } from "./build.ts";
import { fixtureFileName, fixturesDir } from "./generate.ts";
import { SHAPES } from "./shapes.ts";

describe("fixture builder", () => {
	it("numbers ids in append order and advances timestamps one second per entry", () => {
		const b = new SessionBuilder({ id: "s", startedAt: "2026-01-01T00:00:00.000Z" });
		const first = b.user("a");
		const second = b.assistant({ text: "b" });
		expect([first, second]).toEqual(["e1", "e2"]);
		const entries = b.toEntries();
		expect(entries[0]).toMatchObject({ type: "session", version: 3, id: "s", cwd: "/repo" });
		expect(entries[1]).toMatchObject({ id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" });
		expect(entries[2]).toMatchObject({ id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:02.000Z" });
		expect(b.toJsonl().endsWith("\n")).toBe(true);
	});

	it("forks when the leaf is moved", () => {
		const b = new SessionBuilder();
		const root = b.user("a");
		b.assistant({ text: "b" });
		b.branchFrom(root);
		const forked = b.user("c");
		const entries = b.toEntries();
		expect(entries.find((entry) => entry.id === forked)).toMatchObject({ parentId: root });
	});

	it("checkpoints the replayed system state in a compaction", () => {
		const b = new SessionBuilder();
		b.system();
		b.system({ sections: { skills: null, extra: "<extra>\nx\n</extra>" }, toolsRemoved: ["write"] });
		b.user("a");
		b.assistant({ text: "b" });
		b.compaction({ summary: "s", firstKeptEntryId: null, tokensBefore: 1, systemMessage: true });
		const entries = b.toEntries();
		const checkpoint = entries[5].systemMessage;
		expect(Object.keys(checkpoint.sections)).toEqual(["preamble", "tools", "rules", "project_context", "cwd", "extra"]);
		expect(checkpoint.toolsAdded.map((tool: { name: string }) => tool.name)).toEqual(["read", "bash", "edit"]);
		expect(entries[5].firstKeptEntryId).toBe("e5");
	});
});

describe("committed fixtures", () => {
	for (const [name, build] of Object.entries(SHAPES)) {
		it(`${fixtureFileName(name)} matches its shape (run fixtures/generate.ts after changing it)`, () => {
			expect(readFileSync(join(fixturesDir(), fixtureFileName(name)), "utf8")).toBe(build().toJsonl());
		});
	}
});
