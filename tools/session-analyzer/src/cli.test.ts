import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const cliPath = join(here, "cli.ts");

describe("cli", () => {
	it("prints usage without a subcommand and rejects unknown ones", () => {
		expect(run([]).code).toBe(2);
		expect(run(["help"]).code).toBe(0);
		expect(run(["help"]).stdout).toMatch(/usage:/);
		const unknown = run(["frobnicate"]);
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toMatch(/unknown subcommand/);
	});

	it("reports missing or wrong paths without a stack trace", () => {
		expect(run(["inspect"])).toMatchObject({ code: 1 });
		expect(run(["inspect"]).stderr).toMatch(/missing argument/);
		expect(run(["inspect", "/no/such/file.jsonl"]).stderr).toMatch(/no such path/);
		const notASession = run(["list", join(fixtures, "..", "src", "cli.ts")]);
		expect(notASession.code).toBe(0);
		expect(notASession.stderr).toMatch(/skipped .*cli\.ts: .*not a pi session file/);
		expect(notASession.stdout).toMatch(/0 sessions/);
		const badOption = run(["inspect", join(fixtures, "linear.jsonl"), "--turn", "x"]);
		expect(badOption.code).toBe(1);
		expect(badOption.stderr).toMatch(/not an integer/);
	});

	it("inspect prints one row per request point and the open-question facts", () => {
		const result = run(["inspect", join(fixtures, "compaction.jsonl")]);
		expect(result.code).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines[0]).toMatch(/^session compaction {2}version 3 {2}cwd \/repo$/);
		expect(result.stdout).toMatch(/Q1 system sections at last request: preamble, tools, rules, project_context, skills, cwd; context files: \/repo\/AGENTS.md/);
		expect(result.stdout).toMatch(/Q1 tools declared at last request: read, bash, edit, write/);
		expect(result.stdout).toMatch(/Q2 thinking persisted: none/);
		expect(result.stdout).toMatch(/Q4 session version 3/);
		const rows = lines.filter((line) => /^\d+ +\d+ +\S/.test(line));
		expect(rows).toHaveLength(5);
		expect(rows[0]).toMatch(/\b50k\b/);
		expect(rows[0]).toMatch(/toolUse/);
	});

	it("inspect --json returns the session view", () => {
		const result = run(["inspect", join(fixtures, "model-change.jsonl"), "--json"]);
		expect(result.code).toBe(0);
		const json = JSON.parse(result.stdout);
		expect(json.id).toBe("model-change");
		expect(json.requestPoints).toHaveLength(2);
		expect(json.requestPoints[1].thinkingLevel).toBe("high");
		expect(json.requestPoints[1].context.entryIds).toContain("e1");
		expect(json.requestPoints[1].context.messages).toBeUndefined();
	});

	it("list walks a directory and filters by model, since and until", () => {
		const all = run(["list", fixtures]);
		expect(all.code).toBe(0);
		expect(all.stdout).toMatch(/11 sessions, 32 requests/);
		expect(all.stdout).toMatch(/^compaction\.jsonl/m);
		const sol = run(["list", fixtures, "--model", "sol", "--json"]);
		expect(JSON.parse(sol.stdout).map((row: { id: string }) => row.id)).toEqual(["model-change"]);
		expect(run(["list", fixtures, "--since", "2027-01-01"]).stdout).toMatch(/0 sessions/);
		expect(run(["list", fixtures, "--until", "2026-01-01"]).stdout).toMatch(/0 sessions/);
		expect(run(["list", join(fixtures, "linear.jsonl")]).stdout).toMatch(/1 sessions, 3 requests/);
		expect(run(["list", join(fixtures, "linear.jsonl"), join(fixtures, "fork.jsonl")]).stdout).toMatch(/2 sessions, 5 requests/);
		expect(JSON.parse(run(["list", join(fixtures, "linear.jsonl"), "--json"]).stdout)[0]).toMatchObject({ version: 3, cwd: "/repo" });
	});

	it("sanitize writes a sibling file by default and honors --out", () => {
		const dir = mkdtempSync(join(tmpdir(), "analyzer-cli-"));
		const out = join(dir, "clean.jsonl");
		const result = run(["sanitize", join(fixtures, "linear.jsonl"), "--out", out]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(out);
		expect(readFileSync(out, "utf8")).not.toMatch(/What does the loader do/);
		expect(run(["sanitize", join(fixtures, "linear.jsonl"), "--out", join(fixtures, "linear.jsonl")]).stderr).toMatch(/refusing/);
	});

	it("runs as a script through node", () => {
		const stdout = execFileSync(process.execPath, [cliPath, "list", fixtures], { encoding: "utf8" });
		expect(stdout).toMatch(/11 sessions/);
	});
});
