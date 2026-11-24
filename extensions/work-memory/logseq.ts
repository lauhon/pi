import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface TodoQuery {
	/** All words must appear in the task text (case-insensitive). */
	query?: string;
	/** Substring of the page name or journal date (e.g. "gls", "2026_11"). */
	page?: string;
	/** Tag or page reference inside the task, without # or [[ ]]. */
	tag?: string;
	markers?: string[];
	limit?: number;
}

export interface Todo {
	page: string;
	marker: string;
	text: string;
	scheduled?: string;
	deadline?: string;
	mtimeMs: number;
}

export const DEFAULT_MARKERS = ["TODO", "DOING", "LATER", "NOW"];

/** Logseq file names encode namespaces as "___" and URL-escape some characters. */
export function pageName(file: string, dir: "pages" | "journals"): string {
	const base = path.basename(file, ".md");
	if (dir === "journals") return base.replace(/_/g, "-");
	let name = base.replace(/___/g, "/");
	try {
		name = decodeURIComponent(name);
	} catch {
		// keep the raw name
	}
	return name;
}

export function parseTodos(content: string, page: string, markers: string[], mtimeMs: number): Todo[] {
	const re = new RegExp(`^\\s*- (${markers.join("|")}) (.*)$`);
	const lines = content.split("\n");
	const out: Todo[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = re.exec(lines[i]);
		if (!m) continue;
		const todo: Todo = { page, marker: m[1], text: m[2].trim(), mtimeMs };
		for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
			const next = lines[j].trim();
			if (next.startsWith("- ")) break;
			const s = /SCHEDULED: <([^>]+)>/.exec(next);
			if (s) todo.scheduled = s[1].slice(0, 10);
			const d = /DEADLINE: <([^>]+)>/.exec(next);
			if (d) todo.deadline = d[1].slice(0, 10);
		}
		out.push(todo);
	}
	return out;
}

function hasTag(text: string, tag: string): boolean {
	const t = tag.toLowerCase();
	const lower = text.toLowerCase();
	return lower.includes(`#${t}`) || lower.includes(`[[${t}]]`) || lower.includes(`#[[${t}]]`);
}

export interface TodoResult {
	todos: Todo[];
	total: number;
}

/** Newest files first, so recent journal tasks win when the limit cuts. */
export function searchTodos(graphDir: string, q: TodoQuery = {}): TodoResult {
	const markers = q.markers?.length ? q.markers.map((m) => m.toUpperCase()).filter((m) => /^[A-Z]+$/.test(m)) : DEFAULT_MARKERS;
	const terms = (q.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const all: Todo[] = [];
	for (const dir of ["journals", "pages"] as const) {
		const full = path.join(graphDir, dir);
		if (!existsSync(full)) continue;
		for (const f of readdirSync(full)) {
			if (!f.endsWith(".md")) continue;
			const page = pageName(f, dir);
			if (q.page && !page.toLowerCase().includes(q.page.toLowerCase())) continue;
			const file = path.join(full, f);
			const content = readFileSync(file, "utf8");
			if (!markers.some((m) => content.includes(`${m} `))) continue;
			all.push(...parseTodos(content, page, markers, statSync(file).mtimeMs));
		}
	}
	const matched = all
		.filter((t) => !q.tag || hasTag(t.text, q.tag))
		.filter((t) => terms.every((w) => `${t.page} ${t.text}`.toLowerCase().includes(w)))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return { todos: matched.slice(0, q.limit ?? 20), total: matched.length };
}

export function formatTodo(t: Todo): string {
	const dates = [t.scheduled && `scheduled ${t.scheduled}`, t.deadline && `deadline ${t.deadline}`].filter(Boolean);
	const text = t.text.length > 160 ? `${t.text.slice(0, 159)}…` : t.text;
	return `- ${t.page}: ${t.marker} ${text}${dates.length ? ` (${dates.join(", ")})` : ""}`;
}
