import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseItems } from "../../../extensions/work-memory/store.ts";
import { run } from "./cli.ts";
import { indexMemory, loadMemory, memoryForSession, memoryPath, parseMemory, sessionLinks, workItemRows } from "./memory.ts";
import { loadSummaries } from "./cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

/** The fixture with its `{{fixtures}}` placeholder replaced by the absolute fixtures path, written to a temp dir. */
function writeMemory(): { file: string; text: string } {
	const text = readFileSync(join(fixtures, "work-memory.jsonl"), "utf8").replaceAll("{{fixtures}}", fixtures);
	const file = join(mkdtempSync(join(tmpdir(), "analyzer-memory-")), "items.jsonl");
	writeFileSync(file, text);
	return { file, text };
}

describe("memory parsing", () => {
	it("parses the same items as the extension's store", () => {
		const { text } = writeMemory();
		const ours = parseMemory(text).map((item) => item.id);
		expect(ours).toEqual(parseItems(text).map((item) => item.id));
		expect(ours).toEqual(["add-badge", "fix-retry", "elsewhere"]);
	});

	it("treats a missing file as no memory", () => {
		expect(loadMemory(join(tmpdir(), "no-such-dir", "items.jsonl"))).toEqual([]);
	});

	it("resolves the path from the option, WORK_MEMORY_DIR, then the home directory", () => {
		expect(memoryPath("/x/items.jsonl", {})).toBe("/x/items.jsonl");
		expect(memoryPath("~/m.jsonl", {})).toBe(join(homedir(), "m.jsonl"));
		expect(memoryPath(undefined, { WORK_MEMORY_DIR: "/w" })).toBe("/w/items.jsonl");
		expect(memoryPath(undefined, {})).toBe(join(homedir(), ".work-memory", "items.jsonl"));
	});

	it("keeps only session file links, resolved", () => {
		const { text } = writeMemory();
		const [badge, retry] = parseMemory(text);
		expect(sessionLinks(badge)).toEqual([join(fixtures, "linear.jsonl"), join(fixtures, "fork.jsonl"), join(fixtures, "gone.jsonl")]);
		expect(sessionLinks(retry)).toEqual([join(fixtures, "linear.jsonl"), join(fixtures, "compaction.jsonl")]);
	});
});

describe("memory per session and per item", () => {
	it("lists the items that link a session with the count of their other sessions", () => {
		const index = indexMemory(parseMemory(writeMemory().text));
		expect(memoryForSession(index, join(fixtures, "linear.jsonl"))).toEqual([
			{ id: "add-badge", title: "Add badge", status: "PR open, waiting on review", done: false, otherSessions: 2 },
			{ id: "fix-retry", title: "Fix retry loop", status: "merged", done: true, otherSessions: 1 },
		]);
		expect(memoryForSession(index, join(fixtures, "..", "fixtures", "fork.jsonl"))).toHaveLength(1);
		expect(memoryForSession(index, join(fixtures, "model-change.jsonl"))).toEqual([]);
	});

	it("totals each item by cost and sums the unlinked sessions last", () => {
		const items = parseMemory(writeMemory().text);
		const { summaries } = loadSummaries([fixtures], { json: false });
		const rows = workItemRows(items, summaries);
		expect(rows.map((row) => row.id)).toEqual([expect.any(String), expect.any(String), "elsewhere", undefined]);
		expect(rows[0].cost).toBeGreaterThanOrEqual(rows[1].cost);
		const badge = rows.find((row) => row.id === "add-badge")!;
		expect(badge).toMatchObject({ sessions: 2, linkedSessions: 3, done: false });
		expect(badge.firstSession! <= badge.lastSession!).toBe(true);
		const elsewhere = rows.find((row) => row.id === "elsewhere")!;
		expect(elsewhere).toMatchObject({ sessions: 0, cost: 0 });
		expect(elsewhere.firstSession).toBeUndefined();
		const unlinked = rows[rows.length - 1];
		expect(unlinked.sessions).toBe(summaries.length - 3);
	});
});

describe("memory in the cli", () => {
	it("label prints the work memory line and the json field", () => {
		const { file } = writeMemory();
		const linear = join(fixtures, "linear.jsonl");
		const text = run(["label", linear, "--memory", file]).stdout;
		expect(text).toMatch(
			/^next session in this directory: .*\nwork memory: add-badge \[open\] Add badge: PR open, waiting on review \(\+2 other sessions\); fix-retry \[done\] Fix retry loop: merged \(\+1 other sessions\)$/m,
		);
		expect(JSON.parse(run(["label", linear, "--memory", file, "--json"]).stdout).memory).toHaveLength(2);
		const none = run(["label", join(fixtures, "model-change.jsonl"), "--memory", file]);
		expect(none.stdout).toMatch(/^work memory: none$/m);
		expect(JSON.parse(run(["label", join(fixtures, "model-change.jsonl"), "--memory", file, "--json"]).stdout).memory).toEqual([]);
	});

	it("a missing memory file is not an error", () => {
		const missing = join(tmpdir(), "no-such-dir", "items.jsonl");
		const label = run(["label", join(fixtures, "linear.jsonl"), "--memory", missing]);
		expect(label.code).toBe(0);
		expect(label.stdout).toMatch(/^work memory: none$/m);
		const result = run(["memory", fixtures, "--memory", missing]);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^0 work items, 17 sessions/m);
	});

	it("memory prints one row per item and a trailing row for unlinked sessions", () => {
		const { file } = writeMemory();
		const result = run(["memory", fixtures, "--memory", file]);
		expect(result.code).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^sessions +turns +req +cost +first +last +state +item$/);
		expect(result.stdout).toMatch(/^ *2 .* open +add-badge: Add badge$/m);
		expect(result.stdout).toMatch(/^ *\d+ .* done +fix-retry: Fix retry loop$/m);
		expect(result.stdout).toMatch(/^ *0 .* open +elsewhere: Nothing local$/m);
		expect(lines[lines.length - 2]).toMatch(/\(sessions no work item links\)$/);
		expect(lines[lines.length - 1]).toBe("3 work items, 17 sessions; 0 items not shown");
		const limited = run(["memory", fixtures, "--memory", file, "--limit", "1"]).stdout.trimEnd().split("\n");
		expect(limited).toHaveLength(lines.length - 2);
		expect(limited[limited.length - 1]).toMatch(/2 items not shown$/);
		const json = JSON.parse(run(["memory", fixtures, "--memory", file, "--json"]).stdout);
		expect(json.items).toBe(3);
		expect(json.rows).toHaveLength(4);
		expect(json.rows[3].id).toBeUndefined();
	});

	it("memory without a directory reads ./sessions and fails clearly when it is absent", () => {
		const cwd = process.cwd();
		process.chdir(mkdtempSync(join(tmpdir(), "analyzer-nosessions-")));
		try {
			const result = run(["memory", "--memory", writeMemory().file]);
			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(/no such path: sessions/);
		} finally {
			process.chdir(cwd);
		}
	});

	it("labels shows the item id of an unlabeled session", () => {
		const { file } = writeMemory();
		const labelsFile = join(mkdtempSync(join(tmpdir(), "analyzer-labels-")), "labels.json");
		writeFileSync(labelsFile, "[]");
		const result = run(["labels", labelsFile, fixtures, "--memory", file, "--limit", "20"]);
		expect(result.stdout).toMatch(/^unlabeled, by cost:\n +cost +req +peak ctx +item +session$/m);
		expect(result.stdout).toMatch(/add-badge,fix-retry +\S*linear\.jsonl$/m);
		const json = JSON.parse(run(["labels", labelsFile, fixtures, "--memory", file, "--limit", "20", "--json"]).stdout);
		expect(json.byCost.find((row: { path: string }) => row.path.endsWith("fork.jsonl")).items).toEqual(["add-badge"]);
	});
});
