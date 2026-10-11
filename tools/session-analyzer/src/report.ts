/**
 * Output: terminal tables and JSON. No analysis here, only formatting of plain data.
 */
import type { RequestPoint, Session } from "./types.ts";

export interface Column {
	key: string;
	label: string;
	align?: "left" | "right";
	/** Truncate cell text to this many characters. */
	max?: number;
}

export type Row = Record<string, unknown>;

export function renderTable(columns: Column[], rows: Row[]): string {
	const cells = rows.map((row) => columns.map((column) => clip(cellText(row[column.key]), column.max)));
	const widths = columns.map((column, i) => Math.max(column.label.length, ...cells.map((row) => row[i].length)));
	const line = (values: string[]) =>
		values
			.map((value, i) => (columns[i].align === "right" ? value.padStart(widths[i]) : value.padEnd(widths[i])))
			.join("  ")
			.trimEnd();
	const out = [line(columns.map((column) => column.label)), line(widths.map((width) => "-".repeat(width)))];
	for (const row of cells) out.push(line(row));
	return out.join("\n");
}

function cellText(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
}

function clip(text: string, max?: number): string {
	const flat = text.replace(/\s+/g, " ");
	if (!max || flat.length <= max) return flat;
	return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function fmtInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

export function fmtTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
	return String(Math.round(value));
}

export function fmtCost(value: number): string {
	if (value === 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

export function fmtPct(fraction: number): string {
	if (!Number.isFinite(fraction)) return "-";
	return `${(fraction * 100).toFixed(1)}%`;
}

export function fmtDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.round(ms / 1000)}s`;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export function fmtDate(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return iso;
	return new Date(time).toISOString().slice(0, 16).replace("T", " ");
}

export function shortModel(model: string): string {
	return model.replace(/^(claude|gpt|gemini)-/, "");
}

/** JSON-safe view of a session: indexes and ids instead of entry objects, Maps as objects. */
export function sessionJson(session: Session): Row {
	return {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		version: session.version,
		parentSession: session.parentSession ?? null,
		window: session.window ?? null,
		startedAt: session.startedAt,
		endedAt: session.endedAt,
		durationMs: session.durationMs,
		entryCount: session.entries.length,
		entryTypeCounts: session.entryTypeCounts,
		messageRoleCounts: session.messageRoleCounts,
		leafId: session.leafId,
		branchLength: session.branch.length,
		turns: session.turns.map((turn) => ({ ...turn })),
		requestPoints: session.requestPoints.map(requestPointJson),
		forks: session.forks,
		branchSummaryCount: session.branchSummaryCount,
		compactions: session.compactions,
	};
}

export function requestPointJson(rp: RequestPoint): Row {
	const { context, toolResults, ...rest } = rp;
	return {
		...rest,
		toolResults: toolResults.map(({ text: _text, ...result }) => result),
		context: { entryCount: context.entries.length, messageCount: context.messages.length, entryIds: context.entries.map((entry) => entry.id) },
	};
}

export function toJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) => (item instanceof Map ? Object.fromEntries(item) : item), 2);
}
