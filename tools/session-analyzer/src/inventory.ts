/**
 * Context inventory: request point -> Segment[] (what filled the window, by source), and the
 * aggregates per session and per directory. Pure functions over the plain data from load.ts.
 *
 * Sizes are character counts (D3). Shares are fractions of the request's total characters;
 * `tokensEstimate` is share × usage context tokens, a proportion, never a tokenizer.
 */
import { assistantToolCalls, contentText, replaySystemMessages, type AgentMessage } from "./load.ts";
import type { RequestPoint, Segment, SegmentSource, Session } from "./types.ts";

/** Section keys pi 1.1.0 writes; any other key is `system.other` with the key as label. */
const KNOWN_SECTIONS: Record<string, SegmentSource> = {
	preamble: "system.preamble",
	tools: "system.tools",
	rules: "system.rules",
	docs: "system.docs",
	addendum: "system.addendum",
	project_context: "system.project_context",
	skills: "system.skills",
	cwd: "system.cwd",
};

export interface SkillLocation {
	name: string;
	location: string;
}

/** The skills the `skills` section offers, from its `<skill>` blocks. */
export function parseSkillLocations(skillsSection: string | undefined): SkillLocation[] {
	if (!skillsSection) return [];
	const skills: SkillLocation[] = [];
	for (const match of skillsSection.matchAll(/<skill>\s*<name>([^<]*)<\/name>[\s\S]*?<location>([^<]*)<\/location>/g)) {
		skills.push({ name: unescapeXml(match[1].trim()), location: unescapeXml(match[2].trim()) });
	}
	return skills;
}

function unescapeXml(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The skill a tool call loads, when its path (or bash command) names a listed skill file. */
export function skillForCall(name: string, args: Record<string, unknown>, skills: SkillLocation[]): string | undefined {
	if (skills.length === 0) return undefined;
	const path = typeof args.path === "string" ? args.path : undefined;
	if (path && (name === "read" || name === "bash" || name === "cat")) {
		const skill = skills.find((candidate) => candidate.location === path);
		if (skill) return skill.name;
	}
	const command = typeof args.command === "string" ? args.command : undefined;
	if (command && name === "bash") {
		const skill = skills.find((candidate) => command.includes(candidate.location));
		if (skill) return skill.name;
	}
	return undefined;
}

const INLINE_SKILL = /^\s*<skill name="([^"]*)"/;

export function inlineSkillName(userText: string): string | undefined {
	const match = INLINE_SKILL.exec(userText);
	return match ? unescapeXml(match[1]) : undefined;
}

export interface RequestInventory {
	requestIndex: number;
	turnIndex: number;
	segments: Segment[];
	totalChars: number;
	contextTokens: number;
	bySource: SourceTotal[];
}

export interface SourceTotal {
	source: SegmentSource;
	label?: string;
	count: number;
	chars: number;
	/** chars / totalChars of the request (or of the session for aggregates). */
	share: number;
	/** share × usage context tokens: a proportion of the measured total, not a tokenizer. */
	tokensEstimate: number;
	/** Earliest position among the segments (lowest index in the message list). */
	position: number;
	/** Oldest segment, in turns. */
	maxAgeTurns: number;
}

/** Segment[] for one request point: every message in pi's projection, by source. */
export function inventoryRequestPoint(rp: RequestPoint, session: Pick<Session, "turnOf">): RequestInventory {
	const { messages, sourceEntryIds } = rp.context;
	const age = (entryId: string) => rp.turnIndex - (session.turnOf.get(entryId) ?? rp.turnIndex);
	const segments: Segment[] = [];
	const system = replaySystemMessages(messages, sourceEntryIds);
	for (const [name, section] of system.sections) {
		segments.push({
			source: KNOWN_SECTIONS[name] ?? "system.other",
			label: KNOWN_SECTIONS[name] ? undefined : name,
			entryId: section.entryId,
			position: section.position,
			chars: section.text.length,
			ageTurns: age(section.entryId),
		});
	}
	for (const block of system.content) {
		segments.push({ source: "system.other", label: "content", entryId: block.entryId, position: block.position, chars: block.text.length, ageTurns: age(block.entryId) });
	}
	for (const [name, declared] of system.tools) {
		const { tool } = declared;
		const chars = (tool.description ?? "").length + JSON.stringify(tool.parameters ?? {}).length;
		segments.push({ source: "tool_description", label: name, entryId: declared.entryId, position: declared.position, chars, ageTurns: age(declared.entryId) });
	}
	const skills = parseSkillLocations(system.sections.get("skills")?.text);
	const toolNameByCallId = new Map<string, { name: string; skill?: string }>();
	messages.forEach((message, position) => {
		const entryId = sourceEntryIds[position] ?? "";
		const ageTurns = age(entryId);
		const push = (source: SegmentSource, chars: number, label?: string) =>
			segments.push({ source, ...(label !== undefined ? { label } : {}), entryId, position, chars, ageTurns });
		switch (message.role) {
			case "system":
				break;
			case "user": {
				const text = contentText(message.content);
				const skill = inlineSkillName(text);
				push("user", text.length, skill ? `skill:${skill}` : undefined);
				break;
			}
			case "assistant": {
				for (const block of message.content ?? []) {
					if (block.type === "text") push("assistant.text", (block.text ?? "").length);
					else if (block.type === "thinking") push("assistant.thinking", (block.thinking ?? "").length);
				}
				for (const call of assistantToolCalls(message)) {
					const args = (call.arguments ?? {}) as Record<string, unknown>;
					const skill = skillForCall(call.name, args, skills);
					toolNameByCallId.set(call.id, { name: call.name, ...(skill ? { skill } : {}) });
					push("assistant.tool_call", JSON.stringify(args).length + call.name.length, call.name);
				}
				break;
			}
			case "toolResult": {
				const origin = toolNameByCallId.get(message.toolCallId);
				const label = origin?.skill ? `skill:${origin.skill}` : (message.toolName ?? origin?.name ?? "unknown");
				push("tool_result", contentText(message.content).length, label);
				break;
			}
			case "custom":
				push("custom_message", contentText(message.content).length, message.customType);
				break;
			case "bashExecution":
				push("bash_execution", (message.command ?? "").length + (message.output ?? "").length);
				break;
			case "compactionSummary":
				push("compaction_summary", (message.summary ?? "").length);
				break;
			case "branchSummary":
				push("branch_summary", (message.summary ?? "").length);
				break;
			default:
				push("custom_message", contentText((message as { content?: unknown }).content).length, String((message as AgentMessage).role));
		}
	});
	segments.sort((a, b) => a.position - b.position);
	const totalChars = segments.reduce((sum, segment) => sum + segment.chars, 0);
	return {
		requestIndex: rp.index,
		turnIndex: rp.turnIndex,
		segments,
		totalChars,
		contextTokens: rp.usage.contextTokens,
		bySource: groupBySource(segments, totalChars, rp.usage.contextTokens),
	};
}

export function groupBySource(segments: Segment[], totalChars: number, contextTokens: number, withLabel = true): SourceTotal[] {
	const groups = new Map<string, SourceTotal>();
	for (const segment of segments) {
		const key = withLabel ? `${segment.source}\u0000${segment.label ?? ""}` : segment.source;
		const group = groups.get(key) ?? {
			source: segment.source,
			...(withLabel && segment.label !== undefined ? { label: segment.label } : {}),
			count: 0,
			chars: 0,
			share: 0,
			tokensEstimate: 0,
			position: segment.position,
			maxAgeTurns: segment.ageTurns,
		};
		group.count++;
		group.chars += segment.chars;
		group.position = Math.min(group.position, segment.position);
		group.maxAgeTurns = Math.max(group.maxAgeTurns, segment.ageTurns);
		groups.set(key, group);
	}
	const totals = [...groups.values()];
	for (const group of totals) {
		group.share = totalChars > 0 ? group.chars / totalChars : 0;
		group.tokensEstimate = Math.round(group.share * contextTokens);
	}
	totals.sort((a, b) => b.chars - a.chars || a.source.localeCompare(b.source));
	return totals;
}

export interface SessionInventory {
	path: string;
	requestCount: number;
	/** Sum over request points: how many characters each source and label occupied across every request. */
	bySource: SourceTotal[];
	/** The same without labels. */
	bySourceOnly: SourceTotal[];
	/** Mean share per source over the request points (each request weighted equally). */
	meanShare: Partial<Record<SegmentSource, number>>;
	peak: RequestInventory | null;
	/** Distinct skills loaded (read of a listed location or inline /skill:), by name. */
	skillsLoaded: string[];
	/** customType -> injected characters over all requests. */
	injections: Record<string, number>;
}

export function inventorySession(session: Session): SessionInventory {
	const requests = session.requestPoints.map((rp) => inventoryRequestPoint(rp, session));
	const allSegments = requests.flatMap((request) => request.segments);
	const totalChars = requests.reduce((sum, request) => sum + request.totalChars, 0);
	const totalTokens = requests.reduce((sum, request) => sum + request.contextTokens, 0);
	const shareSums = new Map<SegmentSource, number>();
	for (const request of requests) {
		for (const group of groupBySource(request.segments, request.totalChars, request.contextTokens, false)) {
			shareSums.set(group.source, (shareSums.get(group.source) ?? 0) + group.share);
		}
	}
	const meanShare: Partial<Record<SegmentSource, number>> = {};
	for (const [source, sum] of shareSums) meanShare[source] = requests.length > 0 ? sum / requests.length : 0;
	let peak: RequestInventory | null = null;
	for (const request of requests) {
		if (!peak || request.contextTokens > peak.contextTokens || (request.contextTokens === peak.contextTokens && request.totalChars > peak.totalChars)) peak = request;
	}
	const skillsLoaded = new Set<string>();
	for (const segment of allSegments) {
		if (segment.label?.startsWith("skill:")) skillsLoaded.add(segment.label.slice("skill:".length));
	}
	const injections: Record<string, number> = {};
	for (const entry of session.branch) {
		if (entry.type === "custom_message") injections[entry.customType] = (injections[entry.customType] ?? 0) + contentText(entry.content).length;
	}
	return {
		path: session.path,
		requestCount: requests.length,
		bySource: groupBySource(allSegments, totalChars, totalTokens),
		bySourceOnly: groupBySource(allSegments, totalChars, totalTokens, false),
		meanShare,
		peak,
		skillsLoaded: [...skillsLoaded].sort(),
		injections,
	};
}

export interface DirectoryInventory {
	sessionCount: number;
	requestCount: number;
	/** Mean of the per-session mean shares, by source. */
	meanShare: Partial<Record<SegmentSource, number>>;
	/** p50 and p90 of per-request share, by source, over every request in the directory. */
	distribution: Partial<Record<SegmentSource, { p50: number; p90: number; max: number }>>;
	/** Sessions sorted by peak context tokens, descending. */
	peaks: { path: string; requestIndex: number; contextTokens: number; totalChars: number }[];
}

export function inventoryDirectory(sessions: Session[]): DirectoryInventory {
	const inventories = sessions.map(inventorySession);
	const sharesBySource = new Map<SegmentSource, number[]>();
	let requestCount = 0;
	for (const session of sessions) {
		for (const rp of session.requestPoints) {
			requestCount++;
			const request = inventoryRequestPoint(rp, session);
			const seen = new Set<SegmentSource>();
			for (const group of groupBySource(request.segments, request.totalChars, request.contextTokens, false)) {
				seen.add(group.source);
				const list = sharesBySource.get(group.source) ?? [];
				list.push(group.share);
				sharesBySource.set(group.source, list);
			}
		}
	}
	const meanShare: Partial<Record<SegmentSource, number>> = {};
	const sums = new Map<SegmentSource, number>();
	for (const inventory of inventories) {
		for (const [source, share] of Object.entries(inventory.meanShare) as [SegmentSource, number][]) sums.set(source, (sums.get(source) ?? 0) + share);
	}
	for (const [source, sum] of sums) meanShare[source] = inventories.length > 0 ? sum / inventories.length : 0;
	const distribution: DirectoryInventory["distribution"] = {};
	for (const [source, shares] of sharesBySource) {
		const sorted = [...shares].sort((a, b) => a - b);
		distribution[source] = { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted[sorted.length - 1] ?? 0 };
	}
	const peaks = inventories
		.filter((inventory) => inventory.peak)
		.map((inventory) => ({ path: inventory.path, requestIndex: inventory.peak!.requestIndex, contextTokens: inventory.peak!.contextTokens, totalChars: inventory.peak!.totalChars }))
		.sort((a, b) => b.contextTokens - a.contextTokens);
	return { sessionCount: sessions.length, requestCount, meanShare, distribution, peaks };
}

/** Nearest-rank percentile of an ascending list; 0 for an empty list. */
export function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[rank];
}
