/**
 * Conformance (spec, Testing): at every request point our context equals pi's own
 * buildContextEntries / buildSessionContext for the same leaf, and both equal an
 * independent reference walk written here from the documented rules. A pi upgrade
 * that changes projection rules fails this test (D6).
 */
import { describe, expect, it } from "vitest";
import { buildContextEntries, buildSessionContext } from "@earendil-works/pi-coding-agent";
import { SHAPES } from "../fixtures/shapes.ts";
import { parseSession, type SessionEntry } from "./load.ts";

function referenceContext(leafId: string | null, byId: Map<string, SessionEntry>): string[] {
	const path: SessionEntry[] = [];
	let current = leafId ? byId.get(leafId) : undefined;
	while (current) {
		path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	let compactionIndex = -1;
	for (let i = 0; i < path.length; i++) if (path[i].type === "compaction") compactionIndex = i;
	if (compactionIndex < 0) return path.map((entry) => entry.id);
	const compaction = path[compactionIndex] as Extract<SessionEntry, { type: "compaction" }>;
	const keptStart = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const kept = keptStart >= 0 ? path.slice(keptStart, compactionIndex) : [];
	const keptIds = kept.filter((entry) => !(entry.type === "message" && entry.message.role === "system")).map((entry) => entry.id);
	return [compaction.id, ...keptIds, ...path.slice(compactionIndex + 1).map((entry) => entry.id)];
}

describe("context conformance with pi", () => {
	for (const [name, build] of Object.entries(SHAPES)) {
		it(`${name}: every request point matches buildContextEntries and the reference walk`, () => {
			const session = parseSession(build().toJsonl(), `${name}.jsonl`);
			expect(session.requestPoints.length).toBeGreaterThan(0);
			for (const rp of session.requestPoints) {
				const assistant = session.byId.get(rp.assistantEntryId)!;
				const leafId = assistant.parentId;
				const ours = rp.context.entries.map((entry) => entry.id);
				const pis = buildContextEntries(session.entries, leafId, session.byId).map((entry) => entry.id);
				expect(ours).toEqual(pis);
				expect(ours).toEqual(referenceContext(leafId, session.byId));
				const context = buildSessionContext(session.entries, leafId, session.byId);
				expect(rp.context.messages.map((message) => message.role)).toEqual(context.messages.map((message) => message.role));
				expect(rp.context.sourceEntryIds).toHaveLength(rp.context.messages.length);
				const assistantInOwnContext = ours.includes(rp.assistantEntryId);
				expect(assistantInOwnContext).toBe(false);
			}
		});
	}

	it("never mixes an abandoned branch into the active timeline", () => {
		const session = parseSession(SHAPES.fork().toJsonl(), "fork.jsonl");
		const abandoned = new Set(session.forks.flatMap((fork) => fork.abandoned.map((branch) => branch.headId)));
		for (const rp of session.requestPoints) {
			for (const entry of rp.context.entries) expect(abandoned.has(entry.id)).toBe(false);
		}
	});
});
