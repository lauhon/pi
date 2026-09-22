/**
 * Tests for `sub` (skills/subagents/sub).
 *
 * Three layers, cheapest first:
 *  - pure functions sourced directly (derive_state, highest_inbox_seq, ...)
 *  - component tests against fake TMUX_BIN/PI_BIN/CMUX_BIN (argv/env capture,
 *    concurrency, locking, ordering) — no real tmux, no real pi
 *  - end-to-end tests with the real beacon + stub provider in a throwaway
 *    tmux socket (spawn -> idle -> resume -> wait -> out -> kill -> closed,
 *    then open-respawn -> resume, asserting turn continuity — defect 2)
 *
 * See skills/subagents/spec-interactive-children.md.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, execFile, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUB = path.join(HERE, "sub");
const BEACON = path.join(HERE, "beacon", "index.ts");
const STUB_PROVIDER = path.join(HERE, "beacon", "testing", "stub-provider.ts");
const FAKE_TMUX = path.join(HERE, "testing", "fake-tmux");
const FAKE_CMUX = path.join(HERE, "testing", "fake-cmux");
const FAKE_PI = path.join(HERE, "testing", "fake-pi");

const REAL_TMUX_BIN = process.env.TMUX_BIN ?? "tmux";
const REAL_PI_BIN = process.env.PI_BIN ?? path.join(os.homedir(), ".volta", "bin", "pi");

function has(bin: string, args: string[]): boolean {
	return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

const REAL_CAPABLE =
	has(REAL_TMUX_BIN, ["-V"]) && existsSync(REAL_PI_BIN) && has(REAL_PI_BIN, ["--version"]);

// ── Generic helpers ──────────────────────────────────────────────────────

let tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
	const d = mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

function uniqueSocket(tag: string): string {
	return `pi-sub-test-${tag}-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
}

function readIfExists(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function readJsonIfExists(file: string): Record<string, unknown> | undefined {
	const raw = readIfExists(file);
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

/**
 * Schedule a shell command to run after `delayMs`, detached, so it lands while
 * a *synchronous* runSub() call is blocking the node thread. setTimeout cannot
 * be used for this: JS timers do not fire during execFileSync.
 */
function laterShell(delayMs: number, script: string): void {
	const child = spawn("bash", ["-c", `sleep ${delayMs / 1000}; ${script}`], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function waitFor<T>(what: string, probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = probe();
		if (last !== undefined && last !== false) return last;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

afterAll(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ── Layer 1: pure functions, sourced directly ────────────────────────────
//
// `sub` is written to be sourceable: every function is pure enough to call
// in isolation via `bash -c 'source sub; <call>'`, no PI_SUB_RUNS or sockets
// required for these.

function sourceCall(script: string): string {
	return execFileSync("bash", ["-c", `set -euo pipefail; source '${SUB}'; ${script}`], {
		encoding: "utf8",
	}).trimEnd();
}

describe("pure: derive_state", () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpDir("pi-sub-pure-");
	});

	function state(alive: boolean, now: number): string {
		return sourceCall(`derive_state '${dir}' ${alive} ${now}`);
	}

	it("alive=false, recorded=idle -> dead", () => {
		writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "idle", turn: 1 }));
		expect(state(false, 1000)).toBe("dead");
	});

	it("alive=false, recorded=closed -> closed", () => {
		writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "closed", turn: 1 }));
		expect(state(false, 1000)).toBe("closed");
	});

	it("alive=false, no state.json -> dead", () => {
		expect(state(false, 1000)).toBe("dead");
	});

	it("alive=true, no state.json, age>20s -> beaconless", () => {
		writeFileSync(path.join(dir, "spawned"), "100");
		expect(state(true, 100 + 21)).toBe("beaconless");
	});

	it("alive=true, no state.json, age<20s -> starting", () => {
		writeFileSync(path.join(dir, "spawned"), "100");
		expect(state(true, 100 + 5)).toBe("starting");
	});

	it("alive=true, state=idle -> idle", () => {
		writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "idle", turn: 3 }));
		expect(state(true, 1000)).toBe("idle");
	});

	it("alive=true, state=running -> running", () => {
		writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "running", turn: 3 }));
		expect(state(true, 1000)).toBe("running");
	});

	it("alive=true, state=blocked -> blocked", () => {
		writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "blocked", turn: 3 }));
		expect(state(true, 1000)).toBe("blocked");
	});

	it("alive=true, state=closed but tmux still alive -> closed (respawn candidate)", () => {
		writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "closed", turn: 3 }));
		expect(state(true, 1000)).toBe("closed");
	});
});

describe("pure: is_pi_agent_dir (E24)", () => {
	it("matches the agent dir itself and anything inside it", () => {
		expect(sourceCall(`is_pi_agent_dir '/Users/x/.pi/agent' '/Users/x/.pi/agent' && echo yes`)).toBe(
			"yes",
		);
		expect(
			sourceCall(`is_pi_agent_dir '/Users/x/.pi/agent/skills' '/Users/x/.pi/agent' && echo yes`),
		).toBe("yes");
	});

	it("does not match a sibling or unrelated dir", () => {
		expect(
			sourceCall(
				`is_pi_agent_dir '/Users/x/.pi/agent-other' '/Users/x/.pi/agent' && echo yes || echo no`,
			),
		).toBe("no");
		expect(
			sourceCall(`is_pi_agent_dir '/Users/x/project' '/Users/x/.pi/agent' && echo yes || echo no`),
		).toBe("no");
	});
});

describe("pure: highest_inbox_seq / turns_covers_seq", () => {
	let dir: string;
	beforeEach(() => {
		dir = tmpDir("pi-sub-inbox-");
		mkdirSync(path.join(dir, "inbox"), { recursive: true });
	});

	it("counts .md, .md.sent and .md.rejected", () => {
		writeFileSync(path.join(dir, "inbox", "000001.md.sent"), "x");
		writeFileSync(path.join(dir, "inbox", "000002.md.rejected"), "x");
		writeFileSync(path.join(dir, "inbox", "000003.md"), "x");
		expect(sourceCall(`highest_inbox_seq '${dir}'`)).toBe("3");
	});

	it("is 0 for an empty inbox", () => {
		expect(sourceCall(`highest_inbox_seq '${dir}'`)).toBe("0");
	});

	it("turns_covers_seq finds a seq inside any record's inbox array", () => {
		writeFileSync(
			path.join(dir, "turns.jsonl"),
			`${JSON.stringify({ turn: 1, inbox: [1, 2] })}\n${JSON.stringify({ turn: 2, inbox: [3] })}\n`,
		);
		expect(sourceCall(`turns_covers_seq '${dir}' 2 && echo yes`)).toBe("yes");
		expect(sourceCall(`turns_covers_seq '${dir}' 3 && echo yes`)).toBe("yes");
		expect(sourceCall(`turns_covers_seq '${dir}' 4 && echo yes || echo no`)).toBe("no");
	});

	it("turns_covers_seq is false with no turns.jsonl", () => {
		expect(sourceCall(`turns_covers_seq '${dir}' 1 && echo yes || echo no`)).toBe("no");
	});
});

// ── Layer 2: component tests against fake TMUX_BIN/PI_BIN/CMUX_BIN ───────

interface Fixture {
	runsDir: string;
	socket: string;
	tmuxLog: string;
	tmuxState: string;
	env: NodeJS.ProcessEnv;
}

function makeFixture(tag: string, extraEnv: NodeJS.ProcessEnv = {}): Fixture {
	const base = tmpDir(`pi-sub-fx-${tag}-`);
	const runsDir = path.join(base, "runs");
	mkdirSync(runsDir, { recursive: true });
	const tmuxLog = path.join(base, "tmux.log");
	const tmuxState = path.join(base, "tmux-state");
	mkdirSync(tmuxState, { recursive: true });
	const socket = uniqueSocket(tag);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_SUB_RUNS: runsDir,
		PI_SUB_SOCKET: socket,
		TMUX_BIN: FAKE_TMUX,
		CMUX_BIN: FAKE_CMUX,
		PI_BIN: FAKE_PI,
		FAKE_TMUX_LOG: tmuxLog,
		FAKE_TMUX_STATE: tmuxState,
		FAKE_CMUX_LOG: path.join(base, "cmux.log"),
		FAKE_PI_LOG: path.join(base, "pi.log"),
		FAKE_PI_SLEEP: "0", // fake pi exits immediately unless a test overrides it
		...extraEnv,
	};
	return { runsDir, socket, tmuxLog, tmuxState, env };
}

function runSub(fx: Fixture, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
	return spawnSync(SUB, args, {
		env: { ...fx.env, ...extraEnv },
		encoding: "utf8",
	});
}

function fakeSessionAlive(fx: Fixture, session: string): boolean {
	return existsSync(path.join(fx.tmuxState, "sessions", session));
}

function tmuxLogLines(fx: Fixture): string[] {
	return (readIfExists(fx.tmuxLog) ?? "").split("\n").filter(Boolean);
}

describe("component: spawn argv/env (E24, defect 1 regression)", () => {
	it("loads the beacon with an absolute path, -a, no positional prompt, and sets the frozen-contract env", async () => {
		const fx = makeFixture("spawn-argv", { FAKE_PI_SLEEP: "3" });
		const cwd = tmpDir("pi-sub-spawn-cwd-");
		const result = runSub(fx, ["spawn", "argv-child", "--cwd", cwd, "--model", "some/model", "do the task"]);
		expect(result.status, result.stderr).toBe(0);

		const dirs = existsSync(fx.runsDir) ? require("node:fs").readdirSync(fx.runsDir) : [];
		expect(dirs).toHaveLength(1);
		const runDir = path.join(fx.runsDir, dirs[0]);

		// turn 1 goes through the inbox, not a positional prompt
		expect(readIfExists(path.join(runDir, "inbox", "000001.md"))).toBe("do the task");

		// The fake writes argv and env as one block: wait for the *complete*
		// record, not merely for the file to exist.
		const record = await waitFor("complete fake-pi log", () => {
			const raw = readIfExists(fx.env.FAKE_PI_LOG as string);
			return raw?.includes("PI_SUB_SOCKET=") ? raw : undefined;
		});
		const [argvBlock, envBlock] = record.split("== env ==");
		const argv = argvBlock.replace("== argv ==", "").trim().split("\n");

		expect(argv).toContain("-a");
		expect(argv).not.toContain("do the task");
		const eIdx = argv.indexOf("-e");
		expect(eIdx).toBeGreaterThanOrEqual(0);
		const beaconPath = argv[eIdx + 1];
		expect(path.isAbsolute(beaconPath)).toBe(true);
		expect(beaconPath).toBe(BEACON);
		expect(argv).toContain("--model");
		expect(argv[argv.indexOf("--model") + 1]).toBe("some/model");
		// no positional (non-flag, non-flag-value) prompt token anywhere in argv
		expect(argv.join(" ")).not.toMatch(/do the task/);

		expect(envBlock).toMatch(/PI_SUB_RUN_DIR=/);
		expect(envBlock).toMatch(/PI_SUB_SESSION=/);
		expect(envBlock).toMatch(/PI_SUB_SOCKET=/);

		// defect 1 regression: no stdout redirect in the tmux new-session argv,
		// pipe-pane used instead
		const lines = tmuxLogLines(fx);
		const newSessionLine = lines.find((l) => l.includes("new-session"));
		expect(newSessionLine).toBeDefined();
		expect(newSessionLine).not.toMatch(/>\s*\S*tmux-stdout\.log/);
		expect(newSessionLine).not.toMatch(/2>&?1|>\s*\S+\.log/);
		const pipePaneLine = lines.find((l) => l.includes("pipe-pane"));
		expect(pipePaneLine).toBeDefined();
		expect(pipePaneLine).toMatch(/tmux-stdout\.log/);
	});

	it("respects --tools and --thinking", async () => {
		const fx = makeFixture("spawn-opts", { FAKE_PI_SLEEP: "2" });
		const cwd = tmpDir("pi-sub-spawn-cwd2-");
		const result = runSub(fx, [
			"spawn",
			"opt-child",
			"--cwd",
			cwd,
			"--tools",
			"read,grep",
			"--thinking",
			"high",
			"task",
		]);
		expect(result.status, result.stderr).toBe(0);
		const record = await waitFor("complete fake-pi log", () => {
			const raw = readIfExists(fx.env.FAKE_PI_LOG as string);
			return raw?.includes("PI_SUB_SOCKET=") ? raw : undefined;
		});
		expect(record).toMatch(/--tools\nread,grep/);
		expect(record).toMatch(/--thinking\nhigh/);
	});
});

describe("component: --cwd inside a pi agent dir is refused (E24)", () => {
	it("refuses any model inside the agent dir with a clear message", () => {
		// A real directory: --cwd must exist, so the agent dir is simulated on disk.
		const agentDir = tmpDir("pi-sub-agentdir-");
		const fx = makeFixture("cwd-refuse", {
			PI_CODING_AGENT_DIR: agentDir,
		});
		const result = runSub(fx, [
			"spawn",
			"refused",
			"--cwd",
			agentDir,
			"--model",
			"github-copilot/claude-haiku-4.5",
			"task",
		]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/agent dir/i);
		expect(result.stderr).toMatch(/V12|model catalog|refus/i);
	});

	// anthropic/* is refused too: in the agent dir `-e` extensions cannot resolve
	// @earendil-works/pi-coding-agent, so pi-claude-code-use never loads, the
	// model id falls back to a custom id, and the API 400s the request.
	it("refuses an anthropic model inside the agent dir, and names the extension-resolution cause", () => {
		const agentDir = tmpDir("pi-sub-agentdir2-");
		const fx = makeFixture("cwd-warn", {
			PI_CODING_AGENT_DIR: agentDir,
			FAKE_PI_SLEEP: "2",
		});
		mkdirSync(path.join(fx.runsDir, ".."), { recursive: true });
		const result = runSub(fx, [
			"spawn",
			"allowed",
			"--cwd",
			agentDir,
			"--model",
			"anthropic/claude-haiku",
			"task",
		]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/agent dir/i);
		expect(result.stderr).toMatch(/extension|resolve/i);
	});
});

describe("component: inbox sequence allocation under concurrency (E3)", () => {
	it("two genuinely concurrent resumes produce two distinct files, delivered in numeric order", async () => {
		const fx = makeFixture("concurrent-resume", { FAKE_TMUX_NO_LAUNCH: "1" });
		const spawned = runSub(fx, ["spawn", "concur", "--cwd", tmpDir("pi-sub-c-"), "first task"]);
		expect(spawned.status, spawned.stderr).toBe(0);
		const runDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		// mark alive so `resume` does not try to respawn (tmux session already
		// exited because fake-pi sleeps 0s) — write_inbox itself doesn't care
		// about liveness, only cmd_resume's respawn branch does, so keep the
		// fake session alive for this test.
		mkdirSync(path.join(fx.tmuxState, "sessions"), { recursive: true });
		writeFileSync(path.join(fx.tmuxState, "sessions", path.basename(runDir)), "");
		writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ state: "idle", turn: 1 }));

		const [a, b] = await Promise.all([
			execFileP(SUB, ["resume", "concur", "message A"], { env: fx.env }),
			execFileP(SUB, ["resume", "concur", "message B"], { env: fx.env }),
		]);
		const seqs = [a, b].map(({ stdout }) => {
			const m = stdout.match(/seq=(\d+)/);
			return m ? Number(m[1]) : -1;
		});
		expect(new Set(seqs).size).toBe(2); // no collision
		expect(seqs.sort()).toEqual([2, 3]);

		// No beacon runs in this fixture, so turn 1 is still queued: the two
		// resumes must have landed *next to* it, not on top of it.
		const files = require("node:fs")
			.readdirSync(path.join(runDir, "inbox"))
			.filter((f: string) => /^\d+\.md$/.test(f))
			.sort();
		expect(files).toEqual(["000001.md", "000002.md", "000003.md"]);
		expect(readIfExists(path.join(runDir, "inbox", "000001.md"))).toBe("first task");
		const contents = files
			.slice(1)
			.map((f: string) => readIfExists(path.join(runDir, "inbox", f)));
		expect(new Set(contents)).toEqual(new Set(["message A", "message B"]));
	});
});

describe("component: wait targets the covering turns.jsonl record (E17), refuses when beaconless (F4)", () => {
	it("returns once the record covering the highest inbox seq lands, even if an earlier settle already happened", async () => {
		const fx = makeFixture("wait-e17", {
			PI_SUB_WAIT_POLL_SECS: "0.05",
			PI_SUB_WAIT_TIMEOUT_SECS: "5",
			FAKE_TMUX_NO_LAUNCH: "1",
		});
		const spawned = runSub(fx, ["spawn", "waiter", "--cwd", tmpDir("pi-sub-w-"), "task one"]);
		expect(spawned.status, spawned.stderr).toBe(0);
		const runDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		writeFileSync(path.join(fx.tmuxState, "sessions", path.basename(runDir)), "");
		writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ state: "idle", turn: 1 }));

		const resumed = runSub(fx, ["resume", "waiter", "task two"]);
		expect(resumed.status, resumed.stderr).toBe(0);
		const seq = Number(resumed.stdout.match(/seq=(\d+)/)?.[1]);
		expect(seq).toBe(2);

		const turnsFile = path.join(runDir, "turns.jsonl");
		const stateFile = path.join(runDir, "state.json");
		const humanRecord = JSON.stringify({
			turn: 2,
			origin: "human",
			userEntries: ["hx"],
			inbox: [],
			out: "out-2.md",
			ts: 1,
		});
		const parentRecord = JSON.stringify({
			turn: 3,
			origin: "parent",
			userEntries: ["u2"],
			inbox: [2],
			out: "out-3.md",
			ts: 2,
		});

		// A human turn settles first (a settle that does NOT cover seq 2), then the
		// parent's own turn. Both are written by detached shells, because runSub is
		// synchronous and would block any JS timer.
		laterShell(100, `printf '%s\\n' ${shq(humanRecord)} >> ${shq(turnsFile)}`);
		laterShell(
			300,
			`printf '%s\\n' ${shq(parentRecord)} >> ${shq(turnsFile)}; printf '%s' ${shq(
				JSON.stringify({ state: "idle", turn: 3 }),
			)} > ${shq(stateFile)}`,
		);

		const start = Date.now();
		const waited = runSub(fx, ["wait", "waiter"]);
		expect(waited.status, waited.stderr).toBe(0);
		expect(Date.now() - start).toBeGreaterThanOrEqual(280); // did not return on the human-only settle
		expect(waited.stdout).toMatch(/turn=3/);
	});

	it("refuses rather than hangs when the child is beaconless", () => {
		const fx = makeFixture("wait-f4", {
			PI_SUB_BEACONLESS_SECS: "0",
			PI_SUB_WAIT_TIMEOUT_SECS: "2",
			FAKE_TMUX_NO_LAUNCH: "1",
		});
		const spawned = runSub(fx, ["spawn", "ghost", "--cwd", tmpDir("pi-sub-g-"), "task"]);
		expect(spawned.status, spawned.stderr).toBe(0);
		const runDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		writeFileSync(path.join(fx.tmuxState, "sessions", path.basename(runDir)), "");
		// no state.json ever appears, and beaconless age threshold is 0

		const start = Date.now();
		const waited = runSub(fx, ["wait", "ghost"]);
		expect(waited.status).not.toBe(0);
		expect(waited.stderr).toMatch(/beaconless/i);
		expect(Date.now() - start).toBeLessThan(2000); // refused immediately, did not wait out the timeout
	});
});

describe("component: kill ordering (V10) and --force", () => {
	it("aborts first, waits for idle, then quits; force-kills only after the grace period", () => {
		const fx = makeFixture("kill-order", {
			PI_SUB_KILL_IDLE_TIMEOUT_SECS: "1",
			PI_SUB_KILL_GRACE_SECS: "1",
			PI_SUB_KILL_POLL_SECS: "0.05",
			FAKE_TMUX_NO_LAUNCH: "1",
		});
		const spawned = runSub(fx, ["spawn", "killme", "--cwd", tmpDir("pi-sub-k-"), "task"]);
		expect(spawned.status, spawned.stderr).toBe(0);
		const runDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		const session = path.basename(runDir);
		writeFileSync(path.join(fx.tmuxState, "sessions", session), "");
		writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ state: "running", turn: 1 }));

		// A fake beacon that goes idle only after seeing control/abort, then closed
		// only after seeing control/quit. It must be a detached shell, not a JS
		// interval: runSub is synchronous and blocks every timer in this process.
		const responder = spawn(
			"bash",
			[
				"-c",
				`for i in $(seq 1 200); do
  if [[ -e ${shq(path.join(runDir, "control", "abort"))} ]]; then
    rm -f ${shq(path.join(runDir, "control", "abort"))}
    printf '%s' ${shq(JSON.stringify({ state: "idle", turn: 1 }))} > ${shq(path.join(runDir, "state.json"))}
  fi
  if [[ -e ${shq(path.join(runDir, "control", "quit"))} ]]; then
    rm -f ${shq(path.join(runDir, "control", "quit"))}
    printf '%s' ${shq(JSON.stringify({ state: "closed", turn: 1 }))} > ${shq(path.join(runDir, "state.json"))}
    rm -f ${shq(path.join(fx.tmuxState, "sessions", session))}
    exit 0
  fi
  sleep 0.02
done`,
			],
			{ detached: true, stdio: "ignore" },
		);
		responder.unref();

		try {
			const result = runSub(fx, ["kill", "killme"]);
			expect(result.status, result.stderr).toBe(0);
		} finally {
			responder.kill();
		}

		// abort was requested before quit
		expect(existsSync(path.join(runDir, "control", "abort"))).toBe(false);
		expect(existsSync(path.join(runDir, "control", "quit"))).toBe(false);
		expect(readJsonIfExists(path.join(runDir, "state.json"))).toMatchObject({ state: "closed" });
		// never force-killed: the fake session already removed itself cleanly
		const lines = tmuxLogLines(fx);
		expect(lines.some((l) => l.includes("kill-session"))).toBe(false);
	});

	it("force-kills straight away, skipping abort/quit", () => {
		const fx = makeFixture("kill-force", { FAKE_TMUX_NO_LAUNCH: "1" });
		const spawned = runSub(fx, ["spawn", "forceme", "--cwd", tmpDir("pi-sub-kf-"), "task"]);
		expect(spawned.status, spawned.stderr).toBe(0);
		const runDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		const session = path.basename(runDir);
		writeFileSync(path.join(fx.tmuxState, "sessions", session), "");
		writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ state: "running", turn: 1 }));

		const result = runSub(fx, ["kill", "forceme", "--force"]);
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(path.join(runDir, "control", "abort"))).toBe(false);
		expect(existsSync(path.join(runDir, "control", "quit"))).toBe(false);
		const lines = tmuxLogLines(fx);
		expect(lines.some((l) => l.includes("kill-session"))).toBe(true);
		expect(fakeSessionAlive(fx, session)).toBe(false);
	});
});

describe("component: open respawn locking (E6) and missing cmux (E18)", () => {
	it("two racing opens on a closed child produce exactly one respawn", async () => {
		const fx = makeFixture("open-race", { PI_SUB_LOCK_POLL_SECS: "0.02", FAKE_PI_SLEEP: "1" });
		const spawned = runSub(fx, ["spawn", "racer", "--cwd", tmpDir("pi-sub-or-"), "task"]);
		expect(spawned.status, spawned.stderr).toBe(0);
		const runDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ state: "closed", turn: 1 }));
		// no session marker: tmux_alive is false -> closed/dead -> respawn path

		const [a, b] = await Promise.all([
			execFileP(SUB, ["open", "racer"], { env: fx.env }),
			execFileP(SUB, ["open", "racer"], { env: fx.env }),
		]);
		expect(a.stdout + b.stdout).toMatch(/racer|not found/);

		const lines = tmuxLogLines(fx);
		const newSessionCalls = lines.filter((l) => l.includes("new-session"));
		expect(newSessionCalls).toHaveLength(1);
	});

	it("prints the manual attach command when cmux is unavailable", () => {
		const fx = makeFixture("open-nocmux", {
			CMUX_BIN: "/definitely/not/a/real/cmux-binary",
			FAKE_TMUX_NO_LAUNCH: "1",
		});
		const spawned = runSub(fx, ["spawn", "nocmux", "--cwd", tmpDir("pi-sub-nc-"), "task"]);
		expect(spawned.status, spawned.stderr).toBe(0);
		const runDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		const session = path.basename(runDir);
		writeFileSync(path.join(fx.tmuxState, "sessions", session), "");
		writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ state: "idle", turn: 1 }));

		const result = runSub(fx, ["open", "nocmux"], { CMUX_BIN: "/definitely/not/a/real/cmux-binary" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/attach -d -t/);
		expect(result.stdout).toMatch(new RegExp(session));
	});
});

describe("component: orphans (parent-alive lease)", () => {
	it("lists a run whose lease is older than the threshold, not a fresh one", () => {
		const fx = makeFixture("orphans", { PI_SUB_ORPHAN_LEASE_SECS: "60", FAKE_TMUX_NO_LAUNCH: "1" });
		const stale = runSub(fx, ["spawn", "stale-child", "--cwd", tmpDir("pi-sub-o1-"), "task"]);
		expect(stale.status, stale.stderr).toBe(0);
		const staleDir = path.join(fx.runsDir, require("node:fs").readdirSync(fx.runsDir)[0]);
		writeFileSync(path.join(fx.tmuxState, "sessions", path.basename(staleDir)), "");
		writeFileSync(path.join(staleDir, "parent-alive"), "");
		const oldTime = new Date(Date.now() - 120_000);
		require("node:fs").utimesSync(path.join(staleDir, "parent-alive"), oldTime, oldTime);

		const fresh = runSub(fx, ["spawn", "fresh-child", "--cwd", tmpDir("pi-sub-o2-"), "task"]);
		expect(fresh.status, fresh.stderr).toBe(0);
		const dirsAfter = require("node:fs")
			.readdirSync(fx.runsDir)
			.filter((d: string) => d !== path.basename(staleDir));
		const freshDir = path.join(fx.runsDir, dirsAfter[0]);
		writeFileSync(path.join(fx.tmuxState, "sessions", path.basename(freshDir)), "");
		writeFileSync(path.join(freshDir, "parent-alive"), "");

		const result = runSub(fx, ["orphans"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/stale-child/);
		expect(result.stdout).not.toMatch(/fresh-child/);
	});
});

// ── Layer 3: end-to-end with the real beacon + stub provider ─────────────

interface RealChild {
	dir: string;
	socket: string;
	name: string;
	session: string;
	env: NodeJS.ProcessEnv;
}

const realSockets = new Set<string>();
const realRunsDirs = new Set<string>();

function killRealServer(socket: string) {
	spawnSync(REAL_TMUX_BIN, ["-L", socket, "kill-server"], { stdio: "ignore" });
}

function realSessionAlive(socket: string, session: string): boolean {
	return (
		spawnSync(REAL_TMUX_BIN, ["-L", socket, "has-session", "-t", session], { stdio: "ignore" })
			.status === 0
	);
}

function spawnRealFixture(tag: string): { runsDir: string; socket: string; env: NodeJS.ProcessEnv } {
	const base = tmpDir(`pi-sub-e2e-${tag}-`);
	const runsDir = path.join(base, "runs");
	mkdirSync(runsDir, { recursive: true });
	const socket = uniqueSocket(`e2e-${tag}`);
	realSockets.add(socket);
	realRunsDirs.add(runsDir);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_SUB_RUNS: runsDir,
		PI_SUB_SOCKET: socket,
		CMUX_BIN: "/definitely/not/a/real/cmux-binary", // exercise the manual-command path deterministically
		PI_SUB_PARENT: `test-parent-${tag}`,
	};
	return { runsDir, socket, env };
}

afterEach(() => {
	for (const socket of realSockets) killRealServer(socket);
	realSockets.clear();
});

describe.runIf(REAL_CAPABLE)("end-to-end: real beacon + stub provider, throwaway socket", () => {
	it(
		"spawn -> idle -> resume -> wait -> out -> kill -> closed, then open-respawn -> resume continues turn numbering without clobbering output (defect 1 + defect 2)",
		async () => {
			const { runsDir, socket, env } = spawnRealFixture("full");
			const cwd = tmpDir("pi-sub-e2e-cwd-");

			const spawned = spawnSync(
				SUB,
				["spawn", "e2e-child", "--cwd", cwd, "--model", "stub/stub-echo", "--ext", STUB_PROVIDER, "first task"],
				{ env, encoding: "utf8" },
			);
			expect(spawned.status, spawned.stderr).toBe(0);
			const dirs = require("node:fs").readdirSync(runsDir);
			expect(dirs).toHaveLength(1);
			const runDir = path.join(runsDir, dirs[0]);
			const session = dirs[0];

			// defect 1 regression: the child must still be alive several seconds
			// after spawn — a stdout redirect made pi exit within ~1s
			await new Promise((r) => setTimeout(r, 3000));
			expect(realSessionAlive(socket, session)).toBe(true);

			await waitFor(`idle-1 (state=${JSON.stringify(readJsonIfExists(path.join(runDir, "state.json")))})`, () =>
				existsSync(path.join(runDir, "idle-1")),
			);
			expect(readIfExists(path.join(runDir, "out-1.md"))).toBe("echo: first task");

			const resumed = spawnSync(SUB, ["resume", "e2e-child", "second task"], { env, encoding: "utf8" });
			expect(resumed.status, resumed.stderr).toBe(0);

			const waited = spawnSync(SUB, ["wait", "e2e-child", "--timeout", "15"], { env, encoding: "utf8" });
			expect(waited.status, waited.stderr).toBe(0);
			expect(waited.stdout).toMatch(/turn=2/);

			const out = spawnSync(SUB, ["out", "e2e-child"], { env, encoding: "utf8" });
			expect(out.status, out.stderr).toBe(0);
			expect(out.stdout).toMatch(/echo: second task/);

			const killed = spawnSync(SUB, ["kill", "e2e-child"], { env, encoding: "utf8" });
			expect(killed.status, killed.stderr).toBe(0);
			expect(realSessionAlive(socket, session)).toBe(false);
			expect(readJsonIfExists(path.join(runDir, "state.json"))).toMatchObject({ state: "closed" });

			// respawn via `open` on the closed child
			const opened = spawnSync(SUB, ["open", "e2e-child"], { env, encoding: "utf8" });
			expect(opened.status, opened.stderr).toBe(0);
			expect(opened.stdout).toMatch(/attach -d -t/); // cmux unavailable -> manual command (E18)
			await waitFor("session alive after respawn", () => realSessionAlive(socket, session));

			// defect 2 end to end: turn numbering must continue, not restart
			const resumedAgain = spawnSync(SUB, ["resume", "e2e-child", "third task after respawn"], {
				env,
				encoding: "utf8",
			});
			expect(resumedAgain.status, resumedAgain.stderr).toBe(0);
			const waitedAgain = spawnSync(SUB, ["wait", "e2e-child", "--timeout", "15"], { env, encoding: "utf8" });
			expect(waitedAgain.status, waitedAgain.stderr).toBe(0);
			expect(waitedAgain.stdout).toMatch(/turn=3/);

			const turns = (readIfExists(path.join(runDir, "turns.jsonl")) ?? "")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
			expect(turns.map((t: { turn: number }) => t.turn)).toEqual([1, 2, 3]);
			expect(turns.every((t: { origin: string }) => t.origin === "parent")).toBe(true);

			// out-2.md (the pre-respawn output) must never have been clobbered
			expect(readIfExists(path.join(runDir, "out-2.md"))).toBe("echo: second task");
			expect(readIfExists(path.join(runDir, "out-3.md"))).toBe("echo: third task after respawn");

			spawnSync(SUB, ["kill", "e2e-child", "--force"], { env, encoding: "utf8" });
		},
		60_000,
	);

	it(
		"E8/V10: stop aborts a genuinely running turn and the child survives; kill mid-turn aborts first",
		async () => {
			const { runsDir, socket, env } = spawnRealFixture("delay");
			const cwd = tmpDir("pi-sub-e2e-delay-cwd-");
			const delayEnv = { ...env, PI_STUB_DELAY_MS: "400" };

			const spawned = spawnSync(
				SUB,
				[
					"spawn",
					"slow-child",
					"--cwd",
					cwd,
					"--model",
					"stub/stub-echo",
					"--ext",
					STUB_PROVIDER,
					"a task with several words in the reply",
				],
				{ env: delayEnv, encoding: "utf8" },
			);
			expect(spawned.status, spawned.stderr).toBe(0);
			const dirs = require("node:fs").readdirSync(runsDir);
			const runDir = path.join(runsDir, dirs[0]);
			const session = dirs[0];

			await waitFor("state=running", () => readJsonIfExists(path.join(runDir, "state.json"))?.state === "running");

			const stopped = spawnSync(SUB, ["stop", "slow-child"], { env: delayEnv, encoding: "utf8" });
			expect(stopped.status, stopped.stderr).toBe(0);

			await waitFor("state=idle after stop", () => readJsonIfExists(path.join(runDir, "state.json"))?.state === "idle");
			expect(realSessionAlive(socket, session)).toBe(true); // E8: child survives

			spawnSync(SUB, ["kill", "slow-child", "--force"], { env: delayEnv, encoding: "utf8" });
		},
		30_000,
	);
});

describe.skipIf(REAL_CAPABLE)("end-to-end: real beacon + stub provider", () => {
	it("skipped: tmux or pi unavailable", () => {
		expect(REAL_CAPABLE).toBe(false);
	});
});
