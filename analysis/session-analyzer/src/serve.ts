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
 *   GET /events                   Server-Sent Events: {"path"} when a .jsonl changed
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groupBySource, inventoryRequestPoint } from "./inventory.ts";
import { loadSession } from "./load.ts";
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

function jsonlFilesSince(dir: string, cutoffMs: number): { path: string; mtimeMs: number }[] {
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

export interface ServeOptions {
	dirs: string[];
	port: number;
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
	const clients = new Set<ServerResponse>();
	const timers = new Map<string, NodeJS.Timeout>();
	const watchers: FSWatcher[] = [];
	let port = options.port;

	const broadcast = (path: string) => {
		for (const client of clients) client.write(`data: ${JSON.stringify({ path })}\n\n`);
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

	const handle = (req: IncomingMessage, res: ServerResponse) => {
		try {
			const host = req.headers.host ?? "";
			if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new ApiError(403, "bad host");
			if (req.method !== "GET") throw new ApiError(405, "GET only");
			const url = new URL(req.url ?? "/", "http://localhost");
			const q = url.searchParams;
			switch (url.pathname) {
				case "/": {
					res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
					res.end(readFileSync(join(here, "web", "index.html")));
					return;
				}
				case "/api/sessions": {
					const hours = Number(q.get("hours") ?? 24);
					if (!Number.isFinite(hours) || hours <= 0) throw new ApiError(400, "bad hours");
					return sendJson(res, 200, listSessions(dirs, hours));
				}
				case "/api/session":
					return sendJson(res, 200, sessionSeries(dirs, q.get("path")));
				case "/api/request": {
					const raw = q.get("i");
					const index = raw === null ? undefined : Number(raw);
					if (index !== undefined && !Number.isInteger(index)) throw new ApiError(400, "bad i");
					return sendJson(res, 200, requestDetail(dirs, q.get("path"), index));
				}
				case "/events": {
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
					res.write(": connected\n\n");
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
