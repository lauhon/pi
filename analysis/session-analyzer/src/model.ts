/**
 * One model, two ids. Anthropic spells the version with hyphens (`claude-opus-5-5`) and adds a
 * date to a snapshot (`claude-sonnet-4-5-20250929`); GitHub Copilot spells the same model with
 * a dot (`claude-opus-5.5`). A per-model table has to count both under one row, so request
 * points carry the canonical id: dotted, undated. Ids of other vendors are left alone.
 */
const DATED_SNAPSHOT = /^(claude-[a-z]+-\d+(?:-\d{1,2})?)-\d{8}$/;
const HYPHENATED_MINOR = /^(claude-[a-z]+-\d+)-(\d{1,2})$/;

export function canonicalModel(model: string): string {
	const undated = model.replace(DATED_SNAPSHOT, "$1");
	return undated.replace(HYPHENATED_MINOR, "$1.$2");
}
