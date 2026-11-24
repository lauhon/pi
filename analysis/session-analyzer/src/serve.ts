/**
 * `npm run analyze -- serve [--port <n>] [<dir>...]`: a local web view of what fills the context
 * window of live pi sessions. Node built-ins only. Binds 127.0.0.1; serves the page and the JSON
 * below, never any other file. Session files contain secrets, so every `path` must resolve inside
 * a served directory.
 *
 *   GET /                         the page (web/index.html)
 *   GET /api/sessions?hours=24    sessions changed in the last N hours, newest first
 *   GET /api/session?path=        one row per request: tokens and chars by source
 *   GET /api/request?path=&i=     the segments of request i (default last)
 *   GET /api/attention?hours=24   sessions, catches, outcomes, verdicts, focused session (attention inbox v1)
 *   POST /api/steer|verdict|memory  need Host, Origin and the per-start token (header x-attention-token)
 *   GET /events                   Server-Sent Events: {"path"} when a .jsonl changed
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groupBySource, inventoryRequestPoint } from "./inventory.ts";
import { appendVerdict, attentionDir, type Verdict } from "./attention.ts";
import { buildAttention, focusedTitle, listSummaries, matchFocused, sessionRef, writeSteer, writeSubInbox, type Summary } from "./attention-index.ts";
import { loadSession } from "./load.ts";
import { applyOps, loadItems, memoryRoot, saveItems } from "../../../extensions/work-memory/store.ts";
import type { Session } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 4317;
export const LIVE_MS = 2 * 60 * 1000;
const DEBOUNCE_MS = 750;
const KEEPALIVE_MS = 20_000;
const CACHE_LIMIT = 16;
const USER_TEXT_CHARS = 120;

export function defaultDirs(): string[] {
	return [resolve(here, "..", "..", "..", "sessions"), join(homedir(), ".pi", "pi-sub-runs")];
}

export class ApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

// ── path guard ─────────────────────────────────────────────────────────────

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/** True when `path` resolves to a location inside one of the dirs. */
export function isInside(dirs: string[], path: string): boolean {
	if (!path || path.includes("\0")) return false;
	const target = real(path);
	return dirs.some((dir) => {
		const rel = relative(real(dir), target);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	});
}

function guarded(dirs: string[], path: string | null | undefined): string {
	if (!path) throw new ApiError(400, "missing path");
	if (!path.endsWith(".jsonl") || !isInside(dirs, path)) throw new ApiError(400, "path is not inside a served directory");
	return resolve(path);
}

/** Session file for an opaque ref from /api/attention. Only files inside a served dir can match. */
export function resolveRef(dirs: string[], ref: string | null | undefined): string {
	if (!ref || !/^[0-9a-f]{16}$/.test(ref)) throw new ApiError(400, "bad ref");
	for (const dir of dirs) {
		for (const file of jsonlFilesSince(dir, 0)) if (sessionRef(file.path) === ref) return file.path;
	}
	throw new ApiError(404, "no such session");
}

// ── cache ──────────────────────────────────────────────────────────────────

interface CacheEntry {
	size: number;
	mtimeMs: number;
	session: Session;
	series?: SessionSeries;
}

const cache = new Map<string, CacheEntry>();
const stats = { loads: 0, inventories: 0 };

export function cacheStats(): { loads: number; inventories: number; size: number } {
	return { ...stats, size: cache.size };
}

export function clearCache(): void {
	cache.clear();
	stats.loads = 0;
	stats.inventories = 0;
}

function cached(path: string): CacheEntry {
	let info;
	try {
		info = statSync(path);
	} catch {
		throw new ApiError(404, "no such session");
	}
	const hit = cache.get(path);
	if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) {
		cache.delete(path);
		cache.set(path, hit);
		return hit;
	}
	let session: Session;
	try {
		session = loadSession(path);
		stats.loads++;
	} catch (error) {
		throw new ApiError(422, `cannot read session: ${(error as Error).message}`);
	}
	const entry: CacheEntry = { size: info.size, mtimeMs: info.mtimeMs, session };
	cache.delete(path);
	cache.set(path, entry);
	while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
	return entry;
}

// ── handlers ───────────────────────────────────────────────────────────────

export interface SessionRow {
	path: string;
	project: string;
	name: string | null;
	mtime: number;
	live: boolean;
	requestCount: number;
	contextTokens: number;
	model: string | null;
	cost: number;
}

export function jsonlFilesSince(dir: string, cutoffMs: number): { path: string; mtimeMs: number }[] {
	const found: { path: string; mtimeMs: number }[] = [];
	const visit = (current: string) => {
		let names: string[];
		try {
			names = readdirSync(current);
		} catch {
			return;
		}
		for (const name of names) {
			if (name === "node_modules" || name === ".git") continue;
			const full = join(current, name);
			let info;
			try {
				info = statSync(full);
			} catch {
				continue;
			}
			if (info.isDirectory()) visit(full);
			else if (name.endsWith(".jsonl") && info.mtimeMs >= cutoffMs) found.push({ path: full, mtimeMs: info.mtimeMs });
		}
	};
	visit(dir);
	return found;
}

function projectName(session: Session, path: string): string {
	const cwd = session.cwd ? basename(session.cwd) : "";
	return cwd || basename(dirname(path));
}

function sessionName(session: Session): string | null {
	for (let i = session.entries.length - 1; i >= 0; i--) {
		const entry = session.entries[i] as { type: string; name?: unknown };
		if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) return entry.name.trim();
	}
	return null;
}

export function listSessions(dirs: string[], hours = 24, now = Date.now()): SessionRow[] {
	const cutoff = now - hours * 3_600_000;
	const rows: SessionRow[] = [];
	for (const dir of dirs) {
		for (const file of jsonlFilesSince(dir, cutoff)) {
			let session: Session;
			try {
				session = cached(file.path).session;
			} catch {
				continue;
			}
			const points = session.requestPoints;
			const last = points[points.length - 1];
			rows.push({
				path: file.path,
				project: projectName(session, file.path),
				name: sessionName(session),
				mtime: file.mtimeMs,
				live: now - file.mtimeMs <= LIVE_MS,
				requestCount: points.length,
				contextTokens: last?.usage.contextTokens ?? 0,
				model: last?.model ?? null,
				cost: points.reduce((sum, rp) => sum + rp.usage.cost, 0),
			});
		}
	}
	return rows.sort((a, b) => b.mtime - a.mtime);
}

export interface SeriesPoint {
	requestIndex: number;
	turnIndex: number;
	timestamp: string;
	model: string;
	contextTokens: number;
	totalChars: number;
	cost: number;
	chars: Record<string, number>;
}

export interface SessionSeries {
	path: string;
	project: string;
	name: string | null;
	points: SeriesPoint[];
	compactions: number[];
	turns: { turnIndex: number; userText: string }[];
}

export function sessionSeries(dirs: string[], path: string | null | undefined): SessionSeries {
	const file = guarded(dirs, path);
	const entry = cached(file);
	if (entry.series) return entry.series;
	const { session } = entry;
	const points: SeriesPoint[] = session.requestPoints.map((rp) => {
		stats.inventories++;
		const inventory = inventoryRequestPoint(rp, session);
		const chars: Record<string, number> = {};
		for (const group of groupBySource(inventory.segments, inventory.totalChars, inventory.contextTokens, false)) chars[group.source] = group.chars;
		return {
			requestIndex: rp.index,
			turnIndex: rp.turnIndex,
			timestamp: rp.timestamp,
			model: rp.model,
			contextTokens: rp.usage.contextTokens,
			totalChars: inventory.totalChars,
			cost: rp.usage.cost,
			chars,
		};
	});
	const position = new Map(session.entries.map((e, i) => [e.id, i]));
	const compactions: number[] = [];
	for (const compaction of session.compactions) {
		const at = position.get(compaction.id);
		if (at === undefined) continue;
		const next = session.requestPoints.find((rp) => (position.get(rp.assistantEntryId) ?? -1) > at);
		if (next) compactions.push(next.index);
	}
	entry.series = {
		path: file,
		project: projectName(session, file),
		name: sessionName(session),
		points,
		compactions,
		turns: session.turns.map((turn) => ({ turnIndex: turn.index, userText: turn.userText.slice(0, USER_TEXT_CHARS) })),
	};
	return entry.series;
}

export function requestDetail(dirs: string[], path: string | null | undefined, index?: number) {
	const file = guarded(dirs, path);
	const { session } = cached(file);
	const points = session.requestPoints;
	const i = index ?? points.length - 1;
	const rp = points[i];
	if (!Number.isInteger(i) || !rp) throw new ApiError(404, `no request ${index}; the session has ${points.length}`);
	const inventory = inventoryRequestPoint(rp, session);
	const tokens = (chars: number) => (inventory.totalChars > 0 ? Math.round((chars / inventory.totalChars) * inventory.contextTokens) : 0);
	return {
		requestIndex: rp.index,
		turnIndex: rp.turnIndex,
		contextTokens: inventory.contextTokens,
		totalChars: inventory.totalChars,
		segments: inventory.segments.map((s) => ({ source: s.source, label: s.label ?? null, chars: s.chars, tokens: tokens(s.chars), ageTurns: s.ageTurns, position: s.position })),
		bySource: groupBySource(inventory.segments, inventory.totalChars, inventory.contextTokens, false),
	};
}

// ── server ─────────────────────────────────────────────────────────────────

/** The cmux calls, injectable so tests need no cmux. */
export interface Cmux {
	tree(): Promise<unknown | null>;
	notify(title: string, body: string): Promise<void>;
}

export interface ServeOptions {
	dirs: string[];
	port: number;
	/** Defaults to $PI_ATTENTION_DIR or ~/.pi/attention. */
	attentionDir?: string;
	/** Defaults to the `cmux` binary on PATH; null disables focus and notifications. */
	cmux?: Cmux | null;
}

const MAX_BODY = 16 * 1024;
const FOCUS_TTL_MS = 3000;
const LOOKUP_HOURS = 24 * 14;

function run(cmd: string, args: string[]): Promise<string | null> {
	return new Promise((done) => {
		execFile(cmd, args, { timeout: 2500, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => done(error ? null : String(stdout)));
	});
}

export function realCmux(): Cmux | null {
	const onPath = (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, "cmux")));
	if (!onPath) return null;
	return {
		async tree() {
			const out = await run("cmux", ["tree", "--all", "--json"]);
			if (!out) return null;
			try {
				return JSON.parse(out);
			} catch {
				return null;
			}
		},
		async notify(title, body) {
			await run("cmux", ["notify", "--title", title, "--body", body]);
		},
	};
}

export interface RunningServer {
	server: Server;
	port: number;
	url: string;
	close: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(text);
}

export function startServer(options: ServeOptions): Promise<RunningServer> {
	const { dirs } = options;
	const adir = options.attentionDir ?? attentionDir();
	const cmux = options.cmux === undefined ? realCmux() : options.cmux;
	const token = randomBytes(16).toString("hex");
	// Public id of this server start; pages compare it to notice a restart and reload for the new token.
	const boot = randomBytes(8).toString("hex");
	const startedAt = Date.now();
	const seen = new Set<string>();
	let focusCache: { at: number; info: { known: boolean; title: string | null } } | undefined;
	const clients = new Set<ServerResponse>();
	const timers = new Map<string, NodeJS.Timeout>();
	const watchers: FSWatcher[] = [];
	let port = options.port;

	const broadcast = (path: string, extra: Record<string, unknown> = {}) => {
		for (const client of clients) client.write(`data: ${JSON.stringify({ path, ...extra })}\n\n`);
	};

	const recent = (hours: number): Summary[] => {
		const cutoff = Date.now() - hours * 3_600_000;
		return listSummaries(dirs.flatMap((dir) => jsonlFilesSince(dir, cutoff)));
	};

	/** `known` is false when cmux is missing, rejects the call (detached server) or returns nothing. */
	const focusInfo = async (): Promise<{ known: boolean; title: string | null }> => {
		if (!cmux) return { known: false, title: null };
		if (focusCache && Date.now() - focusCache.at < FOCUS_TTL_MS) return focusCache.info;
		let info: { known: boolean; title: string | null };
		try {
			const tree = await cmux.tree();
			info = tree === null || tree === undefined ? { known: false, title: null } : { known: true, title: focusedTitle(tree) };
		} catch {
			info = { known: false, title: null };
		}
		focusCache = { at: Date.now(), info };
		return info;
	};

	/** One cmux notification per catch from a session that is not in focus; existing catches are marked seen first. */
	const scan = async (first = false): Promise<void> => {
		const all = recent(24);
		const fresh = all.flatMap((s) => s.catches.map((c) => ({ s, c, key: `${c.sessionId}:${c.entryId}` }))).filter((x) => !seen.has(x.key));
		for (const x of fresh) seen.add(x.key);
		if (first || !cmux || fresh.length === 0) return;
		const focus = await focusInfo();
		if (!focus.known) return;
		const focused = matchFocused(focus.title, all);
		for (const x of fresh) {
			if (x.s.id === focused || Date.parse(x.c.timestamp) < startedAt) continue;
			await cmux.notify(`${x.s.project}: assumption`, x.c.decision).catch(() => {});
		}
	};
	for (const dir of dirs) {
		try {
			const watcher = watch(dir, { recursive: true }, (_event, filename) => {
				if (!filename || !String(filename).endsWith(".jsonl")) return;
				const path = join(dir, String(filename));
				clearTimeout(timers.get(path));
				timers.set(
					path,
					setTimeout(() => {
						timers.delete(path);
						void scan().catch(() => {});
						broadcast(path);
					}, DEBOUNCE_MS),
				);
			});
			watcher.on("error", () => {});
			watchers.push(watcher);
		} catch {
			// a missing dir is not watched
		}
	}
	const keepAlive = setInterval(() => {
		for (const client of clients) client.write(": keep-alive\n\n");
	}, KEEPALIVE_MS);
	keepAlive.unref();

	const readBody = (req: IncomingMessage): Promise<unknown> =>
		new Promise((done, fail) => {
			const chunks: Buffer[] = [];
			let size = 0;
			let tooBig = false;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY) {
					if (!tooBig) fail(new ApiError(413, "body over 16 KB"));
					tooBig = true;
					chunks.length = 0;
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (tooBig) return;
				try {
					done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch {
					fail(new ApiError(400, "bad json"));
				}
			});
			req.on("error", fail);
		});

	const checkPost = (req: IncomingMessage, host: string): void => {
		if (req.headers.origin !== `http://${host}`) throw new ApiError(403, "bad origin");
		const sent = Buffer.from(String(req.headers["x-attention-token"] ?? ""));
		const want = Buffer.from(token);
		if (sent.length !== want.length || !timingSafeEqual(sent, want)) throw new ApiError(403, "bad token");
	};

	const field = (body: unknown, key: string, max: number, required = true): string | undefined => {
		const v = (body as Record<string, unknown> | null)?.[key];
		if (v === undefined && !required) return undefined;
		if (typeof v !== "string" || (required && v.trim() === "") || v.length > max) throw new ApiError(400, `bad ${key}`);
		return v;
	};

	const post = async (pathname: string, body: unknown): Promise<unknown> => {
		const known = recent(LOOKUP_HOURS);
		switch (pathname) {
			case "/api/steer": {
				const sessionId = field(body, "sessionId", 200)!;
				const text = field(body, "text", 8000)!.trim();
				if (!text) throw new ApiError(400, "bad text");
				const target = known.find((s) => s.id === sessionId);
				if (!target) throw new ApiError(404, "unknown session");
				const file = target.sub ? writeSubInbox(target.sub.runDir, text) : writeSteer(sessionId, text, adir);
				return { ok: true, file };
			}
			case "/api/verdict": {
				const key = field(body, "catchKey", 300)!;
				const verdict = field(body, "verdict", 10)!;
				if (verdict !== "useful" && verdict !== "noise") throw new ApiError(400, "bad verdict");
				if (!known.some((s) => s.catches.some((c) => `${c.sessionId}:${c.entryId}` === key))) throw new ApiError(404, "unknown catch");
				appendVerdict(key, verdict as Verdict, adir);
				return { ok: true };
			}
			case "/api/memory": {
				const key = field(body, "catchKey", 300)!;
				const title = field(body, "title", 200, false)?.trim();
				const status = field(body, "status", 500, false)?.trim();
				let hit: { s: Summary; decision: string } | undefined;
				for (const s of known) {
					const c = s.catches.find((x) => `${x.sessionId}:${x.entryId}` === key);
					if (c) hit = { s, decision: c.decision };
				}
				if (!hit) throw new ApiError(404, "unknown catch");
				const root = memoryRoot();
				const result = applyOps(
					loadItems(root),
					[{ title: title || `Assumption (${hit.s.project}): ${hit.decision}`.slice(0, 200), status: status || "assumption to review" }],
					Date.now(),
					{ cwd: hit.s.cwd || undefined, link: hit.s.path },
				);
				saveItems(root, result.items);
				return { ok: true, added: result.added };
			}
			default:
				throw new ApiError(404, "not found");
		}
	};

	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const host = req.headers.host ?? "";
			if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ApiError(403, "bad host");
			const url = new URL(req.url ?? "/", "http://localhost");
			if (req.method === "POST") {
				checkPost(req, host);
				if (!["/api/steer", "/api/verdict", "/api/memory"].includes(url.pathname)) throw new ApiError(404, "not found");
				const result = await post(url.pathname, await readBody(req));
				broadcast("", { attention: true });
				return sendJson(res, 200, result);
			}
			if (req.method !== "GET") throw new ApiError(405, "GET or POST only");
			const q = url.searchParams;
			switch (url.pathname) {
				case "/": {
					res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
					const html = readFileSync(join(here, "web", "index.html"), "utf8");
					res.end(html.replace("</head>", () => `<meta name="attention-token" content="${token}">\n<meta name="attention-boot" content="${boot}">\n</head>`));
					return;
				}
				case "/api/attention": {
					const hours = Number(q.get("hours") ?? 24);
					if (!Number.isFinite(hours) || hours <= 0) throw new ApiError(400, "bad hours");
					const all = recent(hours);
					const focus = await focusInfo();
					return sendJson(res, 200, buildAttention(all, hours, matchFocused(focus.title, all), Date.now(), adir, focus.known));
				}
				case "/api/sessions": {
					const hours = Number(q.get("hours") ?? 24);
					if (!Number.isFinite(hours) || hours <= 0) throw new ApiError(400, "bad hours");
					return sendJson(res, 200, listSessions(dirs, hours));
				}
				case "/api/session":
					return sendJson(res, 200, sessionSeries(dirs, q.has("ref") ? resolveRef(dirs, q.get("ref")) : q.get("path")));
				case "/api/request": {
					const raw = q.get("i");
					const index = raw === null ? undefined : Number(raw);
					if (index !== undefined && !Number.isInteger(index)) throw new ApiError(400, "bad i");
					return sendJson(res, 200, requestDetail(dirs, q.has("ref") ? resolveRef(dirs, q.get("ref")) : q.get("path"), index));
				}
				case "/events": {
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
					res.write(`event: boot\ndata: ${boot}\n\n`);
					clients.add(res);
					req.on("close", () => clients.delete(res));
					return;
				}
				default:
					throw new ApiError(404, "not found");
			}
		} catch (error) {
			if (error instanceof ApiError) sendJson(res, error.status, { error: error.message });
			else sendJson(res, 500, { error: (error as Error).message });
		}
	};

	const server = createServer(handle);
	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => {
			const address = server.address();
			port = typeof address === "object" && address ? address.port : options.port;
			void scan(true).catch(() => {});
			resolvePromise({
				server,
				port,
				url: `http://127.0.0.1:${port}/`,
				close: () =>
					new Promise<void>((done) => {
						clearInterval(keepAlive);
						for (const timer of timers.values()) clearTimeout(timer);
						for (const watcher of watchers) watcher.close();
						for (const client of clients) client.end();
						server.close(() => done());
						server.closeAllConnections();
					}),
			});
		});
	});
}
