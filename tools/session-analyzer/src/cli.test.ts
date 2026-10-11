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
		expect(all.stdout).toMatch(/17 sessions, 54 requests/);
		expect(all.stdout).toMatch(/^compaction\.jsonl/m);
		const sol = run(["list", fixtures, "--model", "sol", "--json"]);
		expect(JSON.parse(sol.stdout).map((row: { id: string }) => row.id)).toEqual(["model-change"]);
		expect(run(["list", join(fixtures, "linear.jsonl")]).stdout).toMatch(/1 sessions, 3 requests/);
		expect(run(["list", join(fixtures, "linear.jsonl"), join(fixtures, "fork.jsonl")]).stdout).toMatch(/2 sessions, 5 requests/);
		expect(JSON.parse(run(["list", join(fixtures, "linear.jsonl"), "--json"]).stdout)[0]).toMatchObject({ version: 3, cwd: "/repo" });
	});

	it("summary of a file prints the per-turn table and findings, and --json the full summary", () => {
		const result = run(["summary", join(fixtures, "tool-errors.jsonl")]);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^session tool-errors {2}turns 1 {2}requests 5/m);
		expect(result.stdout).toMatch(/errors 2 \(read 2\) {2}missing path 2 {2}failed commands 0 {2}immediate repeats 1 of 1 identical/);
		expect(result.stdout).toMatch(/^after an error: 1 identical, 0 same target, 0 other target, 1 other tool, 0 none; after a missing path: 1 identical, 0 same target, 0 other target, 1 other tool, 0 none$/m);
		expect(result.stdout).toMatch(/^ {3}1 {4}5/m);
		expect(result.stdout).toMatch(/turn 1 {2}warn {2}repeated_identical_call: 1 identical call\(s\) repeated immediately/);
		expect(result.stdout).toMatch(/turn 1 {2}warn {2}error_follow_up: after an error: 1 identical retry\(ies\), 0 guess\(es\) at another target/);
		const json = JSON.parse(run(["summary", join(fixtures, "tool-errors.jsonl"), "--json"]).stdout);
		expect(json.turnObservables).toHaveLength(1);
		expect(json.findings.map((finding: { kind: string }) => finding.kind)).toEqual(["repeated_identical_call", "error_follow_up", "missing_path_error"]);
	});

	it("summary of directories prints the audit-shaped block and honors --exclude and --limit", () => {
		const result = run(["summary", fixtures]);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/^17 sessions \(.*fixtures: 17\), 54 assistant requests, recorded cost \$/m);
		expect(result.stdout).toMatch(/cost concentration: most expensive session \d+\.\d%, five most expensive \d+\.\d%/);
		expect(result.stdout).toMatch(/^gpt-5\.6-terra +53 +\$/m);
		expect(result.stdout).toMatch(/tool errors 3 \(read 2, bash 1\): 2 missing-path, 1 failed commands, 1 immediate identical repeats \(2 identical calls in all\)/);
		expect(result.stdout).toMatch(/^after an error, the next request was: 1 identical, 0 same target, 0 other target, 1 other tool, 1 none$/m);
		expect(result.stdout).toMatch(/^after a missing-path error: 1 identical, 0 same target, 0 other target, 1 other tool, 0 none$/m);
		expect(result.stdout).toMatch(/compactions 2; largest request context 70k tokens/);
		expect(result.stdout).toMatch(/responses over 2,000 chars: 2; over 5,000: 1/);
		const json = JSON.parse(run(["summary", fixtures, "--json", "--limit", "2", "--exclude", "compaction"]).stdout);
		expect(json.sessions).toBe(15);
		expect(json.compactions).toBe(0);
		expect(json.sessionsBySize).toHaveLength(2);
		expect(json.byRoot[fixtures]).toBe(15);
	});

	it("rank orders sessions by score and prints the components", () => {
		const result = run(["rank", fixtures, "--limit", "3"]);
		expect(result.code).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines[2]).toMatch(/^ 1\.00 .*\.jsonl$/);
		expect(lines[lines.length - 1]).toMatch(/^3 sessions ranked; a component is the session's rate per 100 requests/);
		const json = JSON.parse(run(["rank", fixtures, "--json"]).stdout);
		const aborted = json.find((row: { path: string }) => row.path === join(fixtures, "aborted-and-cache-drop.jsonl"));
		expect(aborted).toMatchObject({ score: 1, components: { aborted: 1 }, rates: { aborted: 10 } });
		expect(json[0].score).toBe(1);
		expect(json[json.length - 1].score).toBe(0);
		expect(json.map((row: { score: number }) => row.score)).toEqual([...json.map((row: { score: number }) => row.score)].sort((a, b) => b - a));
	});

	it("--until shows a session as it was then and --since drops earlier requests", () => {
		const file = join(fixtures, "compaction.jsonl");
		const then = JSON.parse(run(["summary", file, "--until", "2026-08-01T10:00:07.000Z", "--json"]).stdout);
		expect(then).toMatchObject({ requests: 3, compactions: 0, turns: 2 });
		const after = JSON.parse(run(["summary", file, "--since", "2026-08-01T10:00:09.000Z", "--json"]).stdout);
		expect(after).toMatchObject({ requests: 2, turns: 1 });
		expect(run(["summary", file, "--until", "2026-08-01"]).stderr).toMatch(/no requests inside the window/);
		const inspected = JSON.parse(run(["inspect", file, "--until", "2026-08-01T10:00:07.000Z", "--json"]).stdout);
		expect(inspected.window).toEqual({ until: "2026-08-01T10:00:07.000Z" });
		expect(inspected.entryCount).toBe(7);
		const dir = run(["list", fixtures, "--until", "2026-08-01T10:00:03.000Z"]);
		expect(dir.stdout).toMatch(/ sessions, /);
		expect(dir.stdout).not.toMatch(/17 sessions/);
		expect(run(["list", fixtures, "--since", "2027-01-01"]).stdout).toMatch(/0 sessions/);
		expect(run(["list", fixtures, "--until", "2026-01-01"]).stdout).toMatch(/0 sessions/);
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
		expect(stdout).toMatch(/17 sessions/);
	});
});
