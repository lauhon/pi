/**
 * Integration: one real pi TUI in a throwaway tmux server, driven only by files.
 *
 * No model call is made — the stub provider (spec V9) answers in-process from a
 * closed port. Every wait is a deadline on a file or a log line, never a sleep.
 *
 * Capability-gated: skips cleanly when tmux or pi is missing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BEACON_DIR = path.dirname(fileURLToPath(import.meta.url));
const BEACON = path.join(BEACON_DIR, "index.ts");
const STUB_PROVIDER = path.join(BEACON_DIR, "testing", "stub-provider.ts");
const RECORDER = path.join(BEACON_DIR, "testing", "event-recorder.ts");

const TMUX_BIN = process.env.TMUX_BIN ?? "tmux";
const PI_BIN = process.env.PI_BIN ?? path.join(os.homedir(), ".volta", "bin", "pi");

function has(bin: string, args: string[]): boolean {
	const result = spawnSync(bin, args, { stdio: "ignore" });
	return result.status === 0;
}

const CAPABLE = has(TMUX_BIN, ["-V"]) && existsSync(PI_BIN) && has(PI_BIN, ["--version"]);

/** Every socket we ever created, so teardown can prove nothing leaked. */
const sockets = new Set<string>();
/** Every run dir we created. */
const runDirs = new Set<string>();

function newSocket(): string {
	// Never `pi-sub`: that is the user's real children.
	const name = `pi-sub-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`;
	sockets.add(name);
	return name;
}

function killServer(socket: string): void {
	spawnSync(TMUX_BIN, ["-L", socket, "kill-server"], { stdio: "ignore" });
}

function serverAlive(socket: string): boolean {
	return spawnSync(TMUX_BIN, ["-L", socket, "list-sessions"], { stdio: "ignore" }).status === 0;
}

function sessionAlive(socket: string, session: string): boolean {
	return (
		spawnSync(TMUX_BIN, ["-L", socket, "has-session", "-t", session], { stdio: "ignore" }).status === 0
	);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a predicate until it holds or the deadline passes. Never a fixed sleep. */
async function waitFor<T>(
	what: string,
	probe: () => T | undefined,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = probe();
		if (last !== undefined && last !== false) return last;
		await sleep(50);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

interface Child {
	readonly dir: string;
	readonly socket: string;
	readonly session: string;
}

function readIfExists(file: string): string | undefined {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function events(child: Child): string[] {
	return (readIfExists(path.join(child.dir, "events.log")) ?? "").split("\n").filter(Boolean);
}

function state(child: Child): { state: string; turn: number; since: number; pid: number } | undefined {
	const raw = readIfExists(path.join(child.dir, "state.json"));
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined; // E27: readers tolerate a parse failure and retry
	}
}

function turns(child: Child): Array<Record<string, unknown>> {
	return (readIfExists(path.join(child.dir, "turns.jsonl")) ?? "")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function inboxDrop(child: Child, seq: number, text: string): void {
	const name = `${String(seq).padStart(6, "0")}.md`;
	writeFileSync(path.join(child.dir, "inbox", name), text, { flag: "wx" });
}

function spawnChild(options: { inbox?: string; idleTtlSecs?: number } = {}): Child {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-sub-it-"));
	runDirs.add(dir);
	mkdirSync(path.join(dir, "inbox"), { recursive: true });
	mkdirSync(path.join(dir, "control"), { recursive: true });
	if (options.inbox !== undefined) {
		writeFileSync(path.join(dir, "inbox", "000001.md"), options.inbox);
	}
	const socket = newSocket();
	const session = "child";

	const env: string[] = [
		`PI_SUB_RUN_DIR=${dir}`,
		`PI_SUB_SESSION=${session}`,
		`PI_SUB_SOCKET=${socket}`,
		"PI_SUB_POLL_MS=200",
	];
	if (options.idleTtlSecs !== undefined) env.push(`PI_SUB_IDLE_TTL=${options.idleTtlSecs}`);

	const cmd = [
		...env.map((e) => `${e}`),
		PI_BIN,
		"-a", // E15: suppress the project trust prompt
		"-ne", // no extension discovery — only the -e paths below
		"-ns",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--session",
		path.join(dir, "session.jsonl"),
		"-e",
		STUB_PROVIDER,
		"-e",
		RECORDER,
		"-e",
		BEACON,
		"--model",
		"stub/stub-echo",
	]
		.map((part) => `'${part.replace(/'/g, "'\\''")}'`)
		.join(" ");

	execFileSync(TMUX_BIN, [
		"-L",
		socket,
		"new-session",
		"-d",
		"-s",
		session,
		"-x",
		"120",
		"-y",
		"40",
		`cd /tmp && env ${cmd} 2>${dir}/stderr.log`,
	]);
	return { dir, socket, session };
}

function diagnostics(child: Child): string {
	return [
		`state: ${readIfExists(path.join(child.dir, "state.json")) ?? "(none)"}`,
		`events: ${events(child).join(",") || "(none)"}`,
		`stderr: ${(readIfExists(path.join(child.dir, "stderr.log")) ?? "").slice(0, 2000)}`,
		`beacon.log: ${readIfExists(path.join(child.dir, "beacon.log")) ?? ""}`,
	].join("\n");
}

afterEach(() => {
	for (const socket of sockets) killServer(socket);
});

afterAll(() => {
	for (const socket of sockets) {
		killServer(socket);
		expect(serverAlive(socket), `tmux server ${socket} leaked`).toBe(false);
		// kill-server leaves the socket file behind; don't litter tmux's socket dir
		// (TMUX_TMPDIR or /tmp — *not* os.tmpdir(), which is per-user on macOS)
		const socketDir = path.join(
			process.env.TMUX_TMPDIR ?? "/tmp",
			`tmux-${process.getuid?.() ?? 0}`,
		);
		rmSync(path.join(socketDir, socket), { force: true });
	}
	for (const dir of runDirs) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(CAPABLE)("real pi + stub provider", () => {
	beforeAll(() => {
		expect(existsSync(BEACON)).toBe(true);
		expect(existsSync(STUB_PROVIDER)).toBe(true);
	});

	it(
		"drives the full file/event sequence with no model call",
		async () => {
			const child = spawnChild({ inbox: "first task\n" });

			// turn 1 — delivered through the inbox, not as a positional prompt
			await waitFor(`idle-1 in ${child.dir}\n${diagnostics(child)}`, () =>
				existsSync(path.join(child.dir, "idle-1")),
			);

			expect(readFileSync(path.join(child.dir, "out-1.md"), "utf8")).toBe("echo: first task");
			expect(existsSync(path.join(child.dir, "inbox", "000001.md.sent"))).toBe(true);
			expect(existsSync(path.join(child.dir, "inbox", "000001.md"))).toBe(false);

			await waitFor("state=idle", () => state(child)?.state === "idle");
			expect(state(child)).toMatchObject({ state: "idle", turn: 1 });
			expect(state(child)?.pid).toBeGreaterThan(0);

			expect(turns(child)).toEqual([
				expect.objectContaining({ turn: 1, origin: "parent", inbox: [1], out: "out-1.md" }),
			]);

			// turn 2 — injected while the child is live
			inboxDrop(child, 2, "second task\n");
			await waitFor(`idle-2\n${diagnostics(child)}`, () =>
				existsSync(path.join(child.dir, "idle-2")),
			);
			expect(readFileSync(path.join(child.dir, "out-2.md"), "utf8")).toBe("echo: second task");
			expect(turns(child)[1]).toMatchObject({ turn: 2, origin: "parent", inbox: [2] });

			// graceful quit through the control plane
			writeFileSync(path.join(child.dir, "control", "quit"), "");
			await waitFor(`state=closed\n${diagnostics(child)}`, () => state(child)?.state === "closed");
			await waitFor("tmux session gone", () => !sessionAlive(child.socket, child.session));

			// the real pi event order the spec claims
			const seq = events(child);
			expect(seq[0]).toBe("session_start");
			expect(seq.at(-1)).toBe("session_shutdown");
			const lifecycle = seq.filter((e) => e !== "agent_end");
			expect(lifecycle).toEqual([
				"session_start",
				"agent_start",
				"agent_settled",
				"agent_start",
				"agent_settled",
				"session_shutdown",
			]);

			// no network: the stub answered, and nothing complained about the closed port
			const stderr = readIfExists(path.join(child.dir, "stderr.log")) ?? "";
			expect(stderr).not.toMatch(/ECONNREFUSED|fetch failed/i);

			// the session file records the injected message as a plain user entry (V8)
			const session = readFileSync(path.join(child.dir, "session.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l));
			const users = session.filter(
				(e: { type?: string; message?: { role?: string } }) =>
					e.type === "message" && e.message?.role === "user",
			);
			expect(users).toHaveLength(2);
			expect(users[0].message.content).toEqual([{ type: "text", text: "first task\n" }]);

			// every assistant message came from the in-process stub, so no model was called
			const assistants = session.filter(
				(e: { type?: string; message?: { role?: string } }) =>
					e.type === "message" && e.message?.role === "assistant",
			);
			expect(assistants).toHaveLength(2);
			for (const a of assistants) {
				expect(a.message.provider).toBe("stub");
				expect(a.message.usage.cost.total).toBe(0);
			}
		},
		90_000,
	);

	it(
		"reaps itself once the idle TTL passes with no client attached",
		async () => {
			const child = spawnChild({ inbox: "quick task\n", idleTtlSecs: 1 });
			await waitFor(`idle-1\n${diagnostics(child)}`, () =>
				existsSync(path.join(child.dir, "idle-1")),
			);
			await waitFor(`state=closed after TTL\n${diagnostics(child)}`, () => state(child)?.state === "closed");
			await waitFor("tmux session gone", () => !sessionAlive(child.socket, child.session));
			expect(readFileSync(path.join(child.dir, "beacon.log"), "utf8")).toMatch(/reaping/);
		},
		90_000,
	);

	it(
		"aborting through control/abort leaves the child alive and idle",
		async () => {
			const child = spawnChild({ inbox: "task\n" });
			await waitFor(`idle-1\n${diagnostics(child)}`, () =>
				existsSync(path.join(child.dir, "idle-1")),
			);
			writeFileSync(path.join(child.dir, "control", "abort"), "");
			await waitFor("abort verb consumed", () => !existsSync(path.join(child.dir, "control", "abort")));
			expect(sessionAlive(child.socket, child.session)).toBe(true);
			expect(state(child)?.state).toBe("idle");
		},
		90_000,
	);
});

describe.skipIf(CAPABLE)("real pi + stub provider", () => {
	it("skipped: tmux or pi unavailable", () => {
		expect(CAPABLE).toBe(false);
	});
});
