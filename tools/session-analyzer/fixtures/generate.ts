/**
 * Write every shape in shapes.ts to fixtures/<name>.jsonl. Run from the repo root:
 *   node tools/session-analyzer/fixtures/generate.ts
 * A test checks the committed files match, so regenerate after changing a shape.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHAPES } from "./shapes.ts";

export function fixtureFileName(name: string): string {
	return `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.jsonl`;
}

export function fixturesDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

export function generateAll(dir = fixturesDir()): string[] {
	const written: string[] = [];
	for (const [name, build] of Object.entries(SHAPES)) {
		const file = join(dir, fixtureFileName(name));
		writeFileSync(file, build().toJsonl());
		written.push(file);
	}
	return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	for (const file of generateAll()) console.log(file);
}
