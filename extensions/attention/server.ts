/**
 * Keeps the attention view (`npm run analyze -- serve`) running: every pi start checks the port
 * and, if nothing answers, starts the server detached so it outlives this session. Several pi
 * sessions starting at once are fine: the losers of the race fail to bind the port and exit.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attentionDir } from "./inbox.ts";

export const DEFAULT_PORT = 4317;

export function repoRoot(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export async function isServing(port: number, timeoutMs = 800): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

export interface EnsureOptions {
	port?: number;
	root?: string;
	logDir?: string;
	probe?: (port: number) => Promise<boolean>;
	start?: (root: string, port: number, logFile: string) => void;
}

function startDetached(root: string, port: number, logFile: string): void {
	const out = openSync(logFile, "a");
	// pi runs on node; fall back to PATH when it runs from another binary.
	const node = path.basename(process.execPath).startsWith("node") ? process.execPath : "node";
	const child = spawn(node, ["analysis/session-analyzer/src/cli.ts", "serve", "--port", String(port)], {
		cwd: root,
		detached: true,
		stdio: ["ignore", out, out],
		env: process.env,
	});
	child.on("error", () => {});
	child.unref();
}

/** Returns "running" when a server already answers, "started" after spawning one, "disabled" if PI_ATTENTION_SERVE=0. */
export async function ensureServer(options: EnsureOptions = {}): Promise<"running" | "started" | "disabled"> {
	if (process.env.PI_ATTENTION_SERVE === "0") return "disabled";
	const port = options.port ?? (Number(process.env.PI_ATTENTION_PORT) || DEFAULT_PORT);
	const probe = options.probe ?? isServing;
	if (await probe(port)) return "running";
	const logDir = options.logDir ?? attentionDir();
	mkdirSync(logDir, { recursive: true });
	(options.start ?? startDetached)(options.root ?? repoRoot(), port, path.join(logDir, "serve.log"));
	return "started";
}
