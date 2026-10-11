# Spec: session analyzer

> Status: **Draft** · 2026-10-11 · Owner: @laurenz · follows up [reports/gpt-5.6-session-audit-2026-08-12.md](../../reports/gpt-5.6-session-audit-2026-08-12.md)

## Goal

A tool that reads pi session files and answers two questions for any session, any turn:

1. What filled the context window the model saw, by source and size.
2. What the agent did in that turn, as countable observables.

The August audit answered these once, by hand, for 40 sessions. Its "still pending" list says
"re-run the audit after 20-30 new sessions". This tool makes the re-run a command. It also
produces the data for three decisions that are open right now:

- Root-cause bad sessions: the earliest turn where a different action would have saved the
  session, and which level that action belongs to (prompt, instructions, model, session
  structure, process, tooling, habit).
- Design `AGENTS.md`, skills and prompts with evidence instead of memory: which rules are
  followed, violated or never relevant.
- Decide whether a live monitor or any model-based check is worth building at all.

## Non-goals

- No model calls until the labeling pass (step 4) is done and step 5 has decided. Measurement
  comes before anything it would measure.
- No live widget, extension, or `/command` before step 6.
- No web UI. The output contract is JSON so any UI can read it later.
- Not a token-saving optimization. `rtk.ts`, `strip-images-copilot.ts` and compaction settings
  are that layer. This tool measures; it does not change requests.
- Not a replacement for `subagents-monitor`. That one observes children; this one observes
  context and turns.

## Why this shape

The live "efficiency monitor" idea is a hypothesis: quality is lost in ways only visible
mid-session. The competing hypotheses sit at other levels and each has a cheaper fix:

| Level | If the cause is here | The fix is |
| --- | --- | --- |
| Prompt | requests are underspecified or ambiguous | a template, or one guideline: ask when ambiguous |
| Standing instructions | prose, unasked assumptions, unverified claims recur | `AGENTS.md` lines, `before_agent_start` guidelines |
| Model and thinking | a weaker model picked to save premium requests | spend the budget on the main model |
| Session structure | contradictions and stale context grow with length | shorter sessions, `/handoff`, subagents |
| Process | endings are confident but unverified | tests in the loop, a done criterion in the prompt |
| Deterministic tooling | constraints get violated | block in `tool_call`, don't flag afterwards |
| Habit | you notice too late that you did not say what you meant | a two-minute pre-prompt checklist |

Where the labels from step 4 cluster is where the solution sits. The analyzer is the instrument
for that labeling and for measuring whatever fix follows. Decision rule for any proposed live
check: when it fires, what do I do? If the answer is "rewind and rephrase", make rewinding
cheaper. If it is "nothing, I just want to know", it is analysis and stays offline. Only a check
whose firing changes the next action in the session earns a live model call.

## Verified facts (2026-10-11)

F1 to F8 were checked against the pi docs and source on `earendil-works/pi` `main`, not against a
running pi. Step 1 re-checks every field name against real files in `sessions/`.

| # | Fact | Consequence |
| --- | --- | --- |
| F1 | Session files are JSONL, version 3, one entry per line, each with `type`, `id`, `parentId`, `timestamp`. Entry types: `session` (header), `message`, `model_change`, `thinking_level_change`, `usage`, `compaction`, `context_edit`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`. | Everything below is derivable from the file. No instrumentation needed for the offline layer. |
| F2 | pi exports `SessionManager.open(path)`, `getBranch()`, `buildContextEntries()`, `buildSessionContext()`, and the standalone functions `loadEntriesFromFile`, `parseSessionEntries`, `migrateSessionEntries`, `buildContextEntries(entries, leafId, byId)`, `buildSessionContext`, `getLatestCompactionEntry` (`packages/coding-agent/src/core/session-manager.ts`). | We do not re-implement tree walking or compaction rules. Context at any point = pi's own projection with the leaf set to that point. |
| F3 | The system message entry stores `sections` (seen: `preamble`, `tools`, `skills`, `cwd`) plus `toolsAdded[]` with name, description, parameters, and `toolsRemoved[]`. | Inventory by source is exact for the system part, and tool descriptions are measurable one by one. |
| F4 | Assistant messages carry `provider`, `model`, `stopReason` and `usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`. | Context size per request comes from `usage`, no tokenizer needed. Cache hit ratio per turn is `cacheRead / (input + cacheRead + cacheWrite)`. |
| F5 | `compaction` entries carry `summary`, `firstKeptEntryId`, `tokensBefore`, optional `usage` and `systemMessage`. `branch_summary` carries `fromId` and `summary`. `context_edit` carries `targetId` and `replacement`. | Compaction count, size before, and summary length are direct. Forks are visible as entries sharing a `parentId`. Prunes are visible. |
| F6 | `custom_message` entries carry `customType`, `content`, `display`, and are part of model context. `custom` entries are not. | Extension injections (for example `subagents-monitor` steer notices) are attributable by `customType`. |
| F7 | This repository is `~/.pi/agent`. Sessions live in `sessions/--<cwd-with-dashes>--/<timestamp>_<id>.jsonl` and are gitignored. | The tool runs from the repo root and defaults to `./sessions`. Fixtures must be sanitized copies, never the originals. |
| F8 | Live extension API: `turn_end` and `agent_before_settle` are boundary events carrying `context.llmMessages` (the exact request), `message`, `toolResults`, `outcome`; handlers may return `entries` (`custom`, `custom_message`, `context_edit`, `compaction`) and `continue: true`. `input` can `transform` or mark input `handled`. `ctx.modelRegistry.complete()` and `streamSimple()` make nested model calls. | Step 6 (live adapter) and the deferred model checks have their hooks. Nothing in steps 1-5 needs them. |
| F9 | `@earendil-works/pi-coding-agent` latest on npm is 1.1.0. This repo's devDependency is the old `@mariozechner/pi-coding-agent ^0.57.1`, used only for types. Extensions import `@earendil-works/pi-coding-agent` at runtime through pi's own loader. | Add `@earendil-works/pi-coding-agent` as a devDependency pinned to the installed pi version (`pi --version`) so the loader parses files with the same code that wrote them. |
| F10 | The August audit parsed `model`, `usage`, tool-call, tool-error and `stopReason` fields locally, then reviewed 40 sessions in eight batches by hand. Its findings: a few sessions dominate cost (top 5 = 81%), only 2 compactions in 40 sessions, contexts up to 314k tokens, 200 tool errors of which 73 missing paths and 55 immediate identical retries, 52 responses over 2,000 characters. | Every one of those is an observable below. The first run of the analyzer should reproduce those numbers for the same period as its acceptance test. |

## Architecture

```
tools/session-analyzer/
  spec-session-analyzer.md     this file
  src/load.ts                  file -> Session (header, entries, active branch, request points)
  src/inventory.ts             request point -> Segment[] (context by source)
  src/observables.ts           turn -> Observables; Session -> SessionSummary
  src/rank.ts                  SessionSummary -> bad-signal score, for the labeling pass
  src/report.ts                JSON out, terminal tables
  src/cli.ts                   `analyze <subcommand>`
  fixtures/                    synthetic sessions + sanitized real ones
  *.test.ts                    collocated
```

Rules:

- `load.ts` is the only module that imports pi's package. Everything after it takes plain data.
  The live adapter in step 6 feeds the same functions from `ctx.sessionManager` and events.
- Pure functions, no I/O below `load.ts` and `report.ts`.
- One request point per assistant message on the active branch. The context for request point
  `i` is `buildContextEntries(entries, leafId = parentId of the assistant entry, byId)`, converted
  with `buildSessionContext`. Abandoned branches are reported separately as forks, never mixed
  into the active timeline.
- Sizes: character counts per segment, `usage` for the true total per request. Display segment
  shares as fractions of the `usage` total. Never estimate tokens per segment with a tokenizer;
  proportions are what the design work needs and chars are provider-neutral.
- Run through root scripts: `npm run analyze -- <args>`. Add `tools/**/*.ts` to `tsconfig.json`
  `include` and `tools/**/*.test.ts` to the vitest `include` list so CI covers it with the existing
  `test.yml`.

### Data contract

```ts
type SegmentSource =
  | "system.preamble" | "system.tools" | "system.skills" | "system.cwd" | "system.other"
  | "tool_description"            // one per toolsAdded entry
  | "user" | "assistant.text" | "assistant.thinking" | "assistant.tool_call"
  | "tool_result"                 // label = tool name
  | "custom_message"              // label = customType
  | "compaction_summary" | "branch_summary";

interface Segment {
  source: SegmentSource;
  label?: string;        // tool name, customType, section key, skill name when derivable
  entryId: string;
  position: number;      // index in the request's message list
  chars: number;
  ageTurns: number;      // turns since the entry was added
}

interface RequestPoint {
  index: number;
  turnIndex: number;
  assistantEntryId: string;
  provider: string;
  model: string;
  thinkingLevel?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  segments: Segment[];
  toolCalls: { id: string; name: string; argsHash: string; path?: string }[];
  toolResults: { id: string; name: string; chars: number; isError: boolean }[];
  stopReason: string;
}

interface Finding {
  kind: string;                      // see observables; later also model-based kinds
  severity: "info" | "warn";
  turnIndex: number;
  evidence: string[];                // entry ids
  message: string;                   // one line
}
```

The same `Finding` shape is used later by any model-based check. The sinks (JSON, terminal,
widget, `pi.appendEntry`) never need to know who produced a finding.

## Context inventory (step 2)

Per request point, group `Segment[]` by `source` and `label`, with chars, share of `usage` total,
position and age. Per session, the same aggregated over all request points, plus the peak.
Per directory, averages and the distribution.

Attribution details to settle in step 1 against real files (see open questions):

- `AGENTS.md` and other context files: which `sections` key carries them.
- Skills: the `skills` section lists names and descriptions; the skill body arrives later as a
  `read` tool result on a path under `skills/`. Count a skill as loaded when such a read exists,
  and attribute that result to `tool_result` with `label = skill:<name>`.
- Tool descriptions: one segment per `toolsAdded` entry, label = tool name. These are the
  segments most likely to surprise.
- Thinking: only if the provider persists it in assistant content.

Three things this layer shows without any attribution method:

- Absence: a rule compacted away, a tool result truncated before the relevant line, a skill never
  loaded, an `AGENTS.md` from a different cwd.
- Duplicates and conflicts: the same instruction in `AGENTS.md`, a skill and the prompt.
- Proportion and position: how much is tool descriptions and skills versus hand-written text, and
  where each rule sits in the window.

## Observables (step 3)

All structural. No model calls. Per turn unless marked.

| Kind | Definition | Source in file |
| --- | --- | --- |
| `asked_question` | assistant text ends the turn with a question and no tool call | assistant content, `stopReason` |
| `tool_calls` | count by tool name | assistant `toolCall` blocks |
| `files_read`, `files_edited` | distinct paths from `read`, `edit`, `write` arguments | tool call args |
| `edit_churn` | same file edited more than once in a turn, or an edit reverting the previous one | tool call args and results |
| `tests_run` | bash command matching a test runner (`vitest`, `jest`, `pytest`, `npm test`, `go test`, `cargo test`); keep the list in one table | bash args |
| `tool_error`, `error_run` | `isError` results; consecutive count; same error text recurring | tool results |
| `missing_path_error` | error text matching no-such-file patterns | tool results (audit finding 3) |
| `repeated_identical_call` | same tool and same `argsHash` as an earlier call in the session; flag "immediately" when adjacent | tool calls (audit: 55 cases) |
| `reread_after_compaction` | `read` of a path that was already read before the latest compaction | tool calls, compaction |
| `stale_file_in_context` | a `read` result for path X still in context after a later `edit` or `write` to X | segments, tool calls |
| `text_before_first_tool` | chars of assistant text preceding the first tool call | assistant content |
| `narration_only` | turn with no tool call and no question | assistant content |
| `long_response` | visible text over 2,000 and over 5,000 chars | assistant content (audit metric) |
| `correction_turn` (user) | short user message after a long assistant turn, opening with a negation or "actually", "I meant", "not that"; keep the cue list in one table | user content |
| `rewind` | entries sharing a `parentId`, `branch_summary` entries | tree |
| `aborted` | `stopReason` aborted or error | assistant |
| `cache_hit_ratio` | `cacheRead / (input + cacheRead + cacheWrite)`, flag drops over 50 points between adjacent requests | usage |
| `model_change`, `thinking_change` | entries of those types | entries |
| `injection` | `custom_message` by `customType`, chars | entries |

Session summary: counts of the above, cost, turns, compactions and `tokensBefore`, peak context,
forks, duration, model mix, and cost share of the most expensive requests. Directory summary:
the August audit's quantitative section, computed.

`rank.ts` scores a session for the labeling pass. Start with a plain sum of normalized
`correction_turn`, `rewind`, `error_run`, `repeated_identical_call`, `aborted`, and peak context
over 200k. The formula is a starting point and lives in one function with a comment that says so.

## Labeling pass (step 4)

Output: `reports/session-labels.json`, one record per reviewed session:

```json
{ "session": "sessions/--...--/2026-...jsonl", "outcome": "bad",
  "earliestSaveTurn": 7, "level": "prompt", "note": "asked for an assessment, agent started editing" }
```

`outcome` is `good`, `bad` or `mixed`, decided by evidence in the file (rewinds, abandonment, a
follow-up session fixing this one, correction turns), not by feel. `level` is one of the table in
"Why this shape", or `unknown`. Target: the 30 to 50 most recent sessions, every bad one labeled.
This file is also the validation set for any model-based check that is proposed later.

## Deferred: model-based checks

Not before step 5. Listed so the hook design is not lost. Ranked by expected lever.

1. Request gate at `input`: is there a goal, a done criterion, a reference to something not in
   context, a conflict with an earlier instruction. One fast call, skipped while steering,
   thresholded so it fires rarely. Output: a `select` with send, send with note, refine.
2. Claim audit at `agent_before_settle`: match final claims to tool evidence in `llmMessages`
   (tests claimed versus a test run result, "updated X" versus an edit on X, each user question
   versus an answer, scope narrowed silently). On a gap, `continue: true` once per run with a
   `custom_message` naming it.
3. Constraint ledger: one extraction call per user turn into `custom` entries; structural
   compliance checks per `turn_end`; re-injected as a guideline in `before_agent_start` after
   compaction. Conflicting ledger entries are the contradiction detector.
4. Assumption surfacing, async from `turn_end`, widget only.
5. Compaction guard: ledger and open threads into `customInstructions`; verify after.
6. Loop diagnosis, triggered only by `error_run` or `repeated_identical_call`.
7. Prose scoring, lowest lever; the structural ratio already shows it.

Validation before any live hook: replay the check over the labeled set from step 4 and report how
often it fires on the turn that mattered versus on good sessions. A request gate that fires on a
third of prompts is noise. Also required: tool output inside slices is treated as untrusted data
in the checker prompt; every `continue: true` has a per-run counter; nested calls are counted and
shown, since they do not appear in pi's session cost.

## Deferred: attribution ("what lights up")

With API-only models there is no attention to read. Causal answers come from outside the model:

- Rule heatmap: extract rules from each `AGENTS.md` and skill version once; score compliance per
  rule per turn with the observables; report rule × relevance × compliance. Inert rules go,
  violated rules get reworded or moved.
- Natural experiments: join `git log` of `AGENTS.md` with session timestamps for before and after
  on every past edit.
- `/ablate <segment>`: fork at the current point, suppress the segment through the `context`
  event, re-send the last prompt, show both turns side by side. Needs the behavior vocabulary
  above so the comparison is a table of observables, not two blobs of text. Repeat three to five
  times per cell; models are not deterministic.
- Probe suite: 10 to 20 fixed prompts run in print mode after each doc edit, observables compared
  to the last run.
- Cheap always-on hints: thinking blocks that name what the model read, lexical overlap between an
  output and context chunks. Hints, not evidence.

The context treemap plus click-to-ablate is the one feature in this whole plan that a terminal
does badly and a browser does well. It reads the JSON contract above, so the UI choice can wait.

## Work breakdown

| Step | Deliverable | Done when |
| --- | --- | --- |
| 1 | `load.ts`, `cli.ts` with `list <dir>` and `inspect <file>`; dependency and config changes; fixture builder and first fixtures; conformance test against pi's own projection | `npm run analyze -- inspect <file>` prints one row per request point with turn, model, context tokens from `usage`, tool call count. Open questions Q1 to Q5 answered in this spec. |
| 2 | `inventory.ts`; `inventory <file> [--turn N]` and `inventory <dir>` | For any session: "what filled the window at turn N" and for a directory: average share by source. First surprises written to the Decisions or a new "Findings" section. |
| 3 | `observables.ts`, `rank.ts`; `summary <file>`, `summary <dir>`, `rank <dir>` | Per-turn table has the observables as columns. Directory summary reproduces the August audit's numbers for its period within rounding. |
| 4 | `reports/session-labels.json` | At least 20 sessions labeled, every bad one with `earliestSaveTurn` and `level`. |
| 5 | A "Decisions" entry in this spec naming the branch taken | Labels cluster read; the cheap fix applied, or the rule heatmap started, or the live checks justified with the replay numbers. |
| 6 | Live adapter extension reading `ctx.sessionManager` and `context`; `/ablate`; web view last | Widget shows step 3 counts live; `/ablate` opens a branch and prints the observable diff. |

Steps 1 to 3 are code against the documented format and run anywhere with fixtures. Steps 2
onward only become interesting against real files in `sessions/` on the machine that wrote them.

## Testing

- vitest, collocated tests, run through `npm test`. Determinism: no timing, no randomness, no
  conditional assertions.
- Fixture builder in `fixtures/build.ts`: a small API that writes a synthetic JSONL with a chosen
  shape (fork, compaction with `firstKeptEntryId`, `custom_message`, tool errors, identical
  retries, a stale read). Each observable has at least one fixture that triggers it and one that
  does not.
- Sanitized real fixtures: a `sanitize <file>` subcommand that keeps structure, ids, usage,
  timestamps, tool names, paths and sizes, and replaces user text, assistant text and tool result
  bodies with same-length placeholders. Only sanitized files are committed.
- Conformance: for every fixture, our context rebuild at every request point equals pi's
  `buildContextEntries` output for the same leaf.

## Decisions

- D1 Offline over files first, live adapter later. The same functions serve both.
- D2 No model calls before step 5.
- D3 Character counts per segment, `usage` for totals, no tokenizer.
- D4 Lives in `tools/`, not `extensions/`, so pi does not load it as an extension.
- D5 One request point per assistant message on the active branch; forks reported separately.
- D6 pi's own loader and projection for parsing, pinned to the installed pi version, with a
  conformance test so a pi upgrade that changes projection rules shows up as a failing test.

## Open questions (settle in step 1 against real files)

- Q1 Which `sections` key carries `AGENTS.md` and other context files, and whether the key set
  differs across pi versions present in `sessions/`.
- Q2 Whether thinking blocks are persisted in assistant content, per provider.
- Q3 How sub-run child sessions appear: same `sessions/` dir, and how to link parent and child
  (`subagents-monitor` writes a `parent` file in the run dir; the session header has
  `parentSession` only for forks).
- Q4 Which session versions exist in `sessions/` and whether `migrateSessionEntries` handles all
  of them.
- Q5 Whether a skill load is always a `read` of `skills/<name>/SKILL.md`, or whether pi inlines
  skills in other ways that need another attribution rule.
