import { beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, cacheStats, clearCache, isInside, listSessions, requestDetail, sessionSeries, startServer } from "./serve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");
const compaction = join(fixtures, "compaction.jsonl");

function status(fn: () => unknown): number | undefined {
	try {
		fn();
	} catch (error) {
		return error instanceof ApiError ? error.status : -1;
	}
	return undefined;
}

beforeEach(() => clearCache());

describe("isInside", () => {
	it("accepts files under a served dir and rejects everything else", () => {
		expect(isInside([fixtures], compaction)).toBe(true);
		expect(isInside([fixtures], join(fixtures, "..", "src", "cli.ts"))).toBe(false);
		expect(isInside([fixtures], `${fixtures}/../src/cli.ts`)).toBe(false);
		expect(isInside([fixtures], "/etc/passwd")).toBe(false);
		expect(isInside([fixtures], fixtures)).toBe(false);
		expect(isInside([fixtures], "")).toBe(false);
	});
});

describe("handlers", () => {
	it("lists sessions newest first with the summary fields", () => {
		const dir = mkdtempSync(join(tmpdir(), "serve-"));
		copyFileSync(compaction, join(dir, "a.jsonl"));
		copyFileSync(join(fixtures, "linear.jsonl"), join(dir, "b.jsonl"));
		const now = Date.now();
		utimesSync(join(dir, "a.jsonl"), new Date(now - 3_600_000), new Date(now - 3_600_000));
		utimesSync(join(dir, "b.jsonl"), new Date(now - 10_000), new Date(now - 10_000));
		const rows = listSessions([dir], 24, now);
		expect(rows.map((r) => r.path)).toEqual([join(dir, "b.jsonl"), join(dir, "a.jsonl")]);
		expect(rows.map((r) => r.live)).toEqual([true, false]);
		expect(rows[1].requestCount).toBeGreaterThan(0);
		expect(rows[1].contextTokens).toBeGreaterThan(0);
		expect(rows[1].model).toBeTruthy();
		expect(rows[1].project).toBe("repo");
		expect(listSessions([dir], 0.5, now).map((r) => r.path)).toEqual([join(dir, "b.jsonl")]);
	});

	it("returns one series row per request, with compactions and turn text", () => {
		const series = sessionSeries([fixtures], compaction);
		expect(series.points.length).toBeGreaterThan(1);
		const [first] = series.points;
		expect(first.totalChars).toBe(Object.values(first.chars).reduce((a, b) => a + b, 0));
		expect(series.compactions.length).toBe(1);
		expect(series.points.some((p) => p.requestIndex === series.compactions[0])).toBe(true);
		expect(series.turns.every((t) => t.userText.length <= 120)).toBe(true);
	});

	it("returns the segments of a request, the last by default", () => {
		const series = sessionSeries([fixtures], compaction);
		const last = requestDetail([fixtures], compaction);
		expect(last.requestIndex).toBe(series.points[series.points.length - 1].requestIndex);
		const first = requestDetail([fixtures], compaction, 0);
		expect(first.segments.length).toBeGreaterThan(0);
		expect(first.segments[0]).toHaveProperty("ageTurns");
		expect(first.bySource.reduce((n, s) => n + s.chars, 0)).toBe(first.totalChars);
		expect(status(() => requestDetail([fixtures], compaction, 9999))).toBe(404);
	});

	it("rejects paths outside the served dirs with 400", () => {
		expect(status(() => sessionSeries([fixtures], "/etc/passwd"))).toBe(400);
		expect(status(() => sessionSeries([fixtures], join(fixtures, "..", "src", "cli.ts")))).toBe(400);
		expect(status(() => sessionSeries([fixtures], `${fixtures}/../../package.json`))).toBe(400);
		expect(status(() => requestDetail([fixtures], undefined))).toBe(400);
	});

	it("parses and inventories a file once while its size and mtime stay the same", () => {
		sessionSeries([fixtures], compaction);
		const first = cacheStats();
		expect(first.loads).toBe(1);
		sessionSeries([fixtures], compaction);
		requestDetail([fixtures], compaction, 0);
		expect(cacheStats()).toEqual(first);
	});

	it("reloads when the file changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "serve-"));
		const file = join(dir, "a.jsonl");
		copyFileSync(compaction, file);
		sessionSeries([dir], file);
		const later = new Date(Date.now() + 5000);
		utimesSync(file, later, later);
		sessionSeries([dir], file);
		expect(cacheStats().loads).toBe(2);
	});
});

describe("server", () => {
	it("serves the page and the api on 127.0.0.1, and nothing else", async () => {
		const running = await startServer({ dirs: [fixtures], port: 0 });
		try {
			const page = await fetch(running.url);
			expect(page.status).toBe(200);
			expect(await page.text()).toMatch(/<svg id="chart"/);
			const list = (await (await fetch(`${running.url}api/sessions?hours=${24 * 365 * 100}`)).json()) as { path: string }[];
			expect(list.some((row) => row.path === compaction)).toBe(true);
			const series = await fetch(`${running.url}api/session?path=${encodeURIComponent(compaction)}`);
			expect(series.status).toBe(200);
			expect(((await series.json()) as { points: unknown[] }).points.length).toBeGreaterThan(0);
			expect((await fetch(`${running.url}api/request?path=${encodeURIComponent(compaction)}`)).status).toBe(200);
			expect((await fetch(`${running.url}api/session?path=/etc/passwd`)).status).toBe(400);
			expect((await fetch(`${running.url}src/serve.ts`)).status).toBe(404);
		} finally {
			await running.close();
		}
	});
});
