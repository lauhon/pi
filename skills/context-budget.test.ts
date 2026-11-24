import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every pi session loads AGENTS.md and the description of each listed skill, so these sizes are
// paid on every request. Budgets from the 2026-11-24 measurement (analyze inventory): AGENTS.md
// 6.4 KB, listed descriptions 3.0 KB after hiding the 56 skills no session had loaded.
const AGENT_DIR = join(import.meta.dirname, "..");
const SKILLS_DIR = import.meta.dirname;
const AGENTS_MD_MAX = 7000;
const LISTED_DESCRIPTIONS_MAX = 3500;
const SKILL_BODY_MAX = 16000;

interface Skill {
	dir: string;
	name?: string;
	description?: string;
	hidden: boolean;
	bytes: number;
}

function frontmatter(text: string): Map<string, string> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	const fields = new Map<string, string>();
	for (const line of match?.[1].split("\n") ?? []) {
		const field = /^([a-z-]+):\s*(.*)$/.exec(line);
		if (field) fields.set(field[1], field[2].replace(/^["']|["']$/g, ""));
	}
	return fields;
}

function skills(): Skill[] {
	return readdirSync(SKILLS_DIR)
		.filter((dir) => statSync(join(SKILLS_DIR, dir)).isDirectory())
		.flatMap((dir) => {
			const file = join(SKILLS_DIR, dir, "SKILL.md");
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				return [];
			}
			const fields = frontmatter(text);
			return [{ dir, name: fields.get("name"), description: fields.get("description"), hidden: fields.get("disable-model-invocation") === "true", bytes: Buffer.byteLength(text) }];
		});
}

describe("agent context budget", () => {
	it(`keeps AGENTS.md under ${AGENTS_MD_MAX} bytes`, () => {
		expect(Buffer.byteLength(readFileSync(join(AGENT_DIR, "AGENTS.md"), "utf8"))).toBeLessThanOrEqual(AGENTS_MD_MAX);
	});

	it("gives every skill a name equal to its directory and a description", () => {
		const broken = skills().filter((skill) => skill.name !== skill.dir || !skill.description);
		expect(broken.map((skill) => skill.dir)).toEqual([]);
	});

	it(`keeps the descriptions of listed skills under ${LISTED_DESCRIPTIONS_MAX} chars in total`, () => {
		const listed = skills().filter((skill) => !skill.hidden);
		const total = listed.reduce((sum, skill) => sum + (skill.description?.length ?? 0), 0);
		expect(total, `listed: ${listed.map((skill) => skill.dir).join(", ")}`).toBeLessThanOrEqual(LISTED_DESCRIPTIONS_MAX);
	});

	it(`keeps each listed skill under ${SKILL_BODY_MAX} bytes`, () => {
		const large = skills().filter((skill) => !skill.hidden && skill.bytes > SKILL_BODY_MAX);
		expect(large.map((skill) => `${skill.dir} ${skill.bytes}`)).toEqual([]);
	});
});
