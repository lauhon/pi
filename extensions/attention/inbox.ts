/**
 * Steer inbox: delivers `$PI_ATTENTION_DIR/steer/<sessionId>/*.md` into the running session.
 * Delivery follows skills/subagents/beacon: idle -> plain prompt, streaming -> steer, and a
 * plain send that loses the race with the agent starting is retried as a steer.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const PREFIX = "[from attention view] ";
const MAX_BYTES = 64 * 1024;
const POLL_MS = 500;

export function attentionDir(): string {
	return process.env.PI_ATTENTION_DIR || path.join(homedir(), ".pi", "attention");
}

export interface Sender {
	sendUserMessage(text: string, options?: { deliverAs: "steer" | "followUp" }): unknown;
}

export interface InboxOptions {
	dir: string;
	sessionId: string;
	isIdle: () => boolean;
	pollMs?: number;
	/** Test hook: replaces setInterval. Returns a stop function. */
	every?: (ms: number, fn: () => void) => () => void;
}

export interface Inbox {
	poll(): Promise<void>;
	stop(): void;
}

function reject(file: string, reason: string): void {
	try {
		renameSync(file, `${file}.rejected`);
		writeFileSync(`${file}.reason.txt`, `${reason}\n`);
	} catch {
		// the file may be gone; nothing left to mark
	}
}

export function startInbox(pi: Sender, options: InboxOptions): Inbox {
	const dir = path.join(options.dir, "steer", options.sessionId);
	mkdirSync(dir, { recursive: true });
	let busy = false;

	async function deliver(text: string): Promise<void> {
		const body = PREFIX + text;
		if (!options.isIdle()) {
			await pi.sendUserMessage(body, { deliverAs: "steer" });
			return;
		}
		try {
			await pi.sendUserMessage(body);
		} catch {
			// the agent started streaming between isIdle() and the send
			await pi.sendUserMessage(body, { deliverAs: "steer" });
		}
	}

	async function poll(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			let names: string[];
			try {
				names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
			} catch {
				return;
			}
			for (const name of names) {
				const file = path.join(dir, name);
				let buffer: Buffer;
				try {
					buffer = readFileSync(file);
				} catch {
					continue;
				}
				if (buffer.byteLength > MAX_BYTES) {
					reject(file, `too large (${buffer.byteLength} bytes > ${MAX_BYTES})`);
					continue;
				}
				const text = buffer.toString("utf8");
				if (text.trim() === "") {
					reject(file, "empty");
					continue;
				}
				try {
					await deliver(text.trim());
				} catch (error) {
					reject(file, `send failed: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				try {
					renameSync(file, `${file}.sent`);
				} catch {
					// already delivered; a leftover .md would be sent twice, so stop here
					return;
				}
			}
		} finally {
			busy = false;
		}
	}

	const every =
		options.every ??
		((ms, fn) => {
			const timer = setInterval(fn, ms);
			timer.unref?.();
			return () => clearInterval(timer);
		});
	const stopTimer = every(options.pollMs ?? POLL_MS, () => void poll());
	return { poll, stop: stopTimer };
}
