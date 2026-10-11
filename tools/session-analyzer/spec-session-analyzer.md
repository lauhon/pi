# Spec: session analyzer

> Status: **Draft** · 2026-10-11 · Owner: @laurenz · follows up [reports/gpt-5.6-session-audit-2026-08-12.md](../../reports/gpt-5.6-session-audit-2026-08-12.md)
>
> Steps 1 to 3 were implemented on 2026-10-11 in a container that had the repo but no
> `sessions/` directory and no `pi` binary. Every fact and answer marked "source" below was
> checked against the installed package `@earendil-works/pi-coding-agent@1.1.0` (dist and
> docs), not against real session files. The first run on the machine that has `sessions/`
> is still owed: `npm run analyze -- inspect <file>` prints the facts for Q1 to Q5 on its
> first lines.

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
running pi. Rows marked "1.1.0" were re-checked on 2026-10-11 against the installed package. The
re-check against real files in `sessions/` is still pending (see the status note at the top).

| # | Fact | Consequence |
| --- | --- | --- |
| F1 | Session files are JSONL, version 3, one entry per line, each with `type`, `id`, `parentId`, `timestamp`. Entry types: `session` (header), `message`, `model_change`, `thinking_level_change`, `usage`, `compaction`, `context_edit`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`. 1.1.0: this is exactly the `SessionEntry` union in `session-manager.d.ts`. | Everything below is derivable from the file. No instrumentation needed for the offline layer. |
| F2 | pi exports `SessionManager`, `buildContextEntries(entries, leafId, byId)`, `buildSessionProjection` (same, plus the source entry of every message), `buildSessionContext`, `sessionEntryToContextMessages`, `parseSessionEntries`, `migrateSessionEntries` and `getLatestCompactionEntry` from the package root. 1.1.0: `loadEntriesFromFile` is not exported from the root, and it appends a newline to a file whose last line has none. The leaf pi resumes a file at is the last entry in the file. | We do not re-implement tree walking or compaction rules. `load.ts` reads the file itself, feeds `parseSessionEntries` and `migrateSessionEntries`, and takes the context at a request point from `buildSessionProjection` with the leaf set to the parent of the assistant entry. Real files are never written. |
| F3 | The system prompt is a `message` entry whose `message.role` is `system`, with `content`, `sections`, `toolsAdded[]` (name, description, parameters) and `toolsRemoved[]`. Later system messages patch `sections` by name (`null` removes one) and add or remove tools; a compaction stores a complete `systemMessage` checkpoint and the kept range drops the earlier system messages. 1.1.0 (`system-prompt.js`): the keys pi writes are `preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, plus any extension section by name. | Inventory replays every system message of a context in order (the rule of pi-ai `getCurrentSystemMessage`), so the system part is exact and tool descriptions are measurable one by one. The key set of older pi versions is read off real files by `inspect`. |
| F4 | Assistant messages carry `provider`, `model`, `stopReason` and `usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`. | Context size per request comes from `usage`, no tokenizer needed. Cache hit ratio per turn is `cacheRead / (input + cacheRead + cacheWrite)`. |
| F5 | `compaction` entries carry `summary`, `firstKeptEntryId`, `tokensBefore`, optional `usage` and `systemMessage`. `branch_summary` carries `fromId` and `summary`. `context_edit` carries `targetId` and `replacement`. | Compaction count, size before, and summary length are direct. Forks are visible as entries sharing a `parentId`. Prunes are visible. |
| F6 | `custom_message` entries carry `customType`, `content`, `display`, and are part of model context. `custom` entries are not. | Extension injections (for example `subagents-monitor` steer notices) are attributable by `customType`. |
| F7 | This repository is `~/.pi/agent`. Interactive sessions live in `sessions/--<cwd-with-dashes>--/<timestamp>_<id>.jsonl` and are gitignored. Sub-run children (`skills/subagents/sub`) start pi with `--session ~/.pi/pi-sub-runs/<run>/session.jsonl` and write the parent's session id to `<run>/parent`, so they are not under `sessions/` at all. | The CLI takes one or more roots and walks them recursively, so `./sessions ~/.pi/pi-sub-runs` covers both populations the August audit counted (15 interactive, 25 sub-runs). Fixtures must be sanitized copies, never the originals. |
| F8 | Live extension API: `turn_end` and `agent_before_settle` are boundary events carrying `context.llmMessages` (the exact request), `message`, `toolResults`, `outcome`; handlers may return `entries` (`custom`, `custom_message`, `context_edit`, `compaction`) and `continue: true`. `input` can `transform` or mark input `handled`. `ctx.modelRegistry.complete()` and `streamSimple()` make nested model calls. | Step 6 (live adapter) and the deferred model checks have their hooks. Nothing in steps 1-5 needs them. |
| F9 | `@earendil-works/pi-coding-agent` latest on npm is 1.1.0, which is also `settings.json` `lastChangelogVersion`. Extensions import it at runtime through pi's own loader. `extensions/premium-usage.disabled/*.ts` still import the old `@mariozechner/pi-coding-agent` for types. | Pinned to `1.1.0` as a devDependency (exact). `pi --version` could not be run where step 1 was done; confirm the pin on the machine that runs pi. The old package stays until the parked extension drops it. |
| F10 | The August audit parsed `model`, `usage`, tool-call, tool-error and `stopReason` fields locally, then reviewed 40 sessions in eight batches by hand. Its findings: a few sessions dominate cost (top 5 = 81%), only 2 compactions in 40 sessions, contexts up to 314k tokens, 200 tool errors of which 73 missing paths and 55 immediate identical retries, 52 responses over 2,000 characters. | Every one of those is an observable below. The first run of the analyzer should reproduce those numbers for the same period as its acceptance test. |
| F11 | Node 22 runs `.ts` files directly (type stripping), and `npm run analyze` is `node tools/session-analyzer/src/cli.ts`. 1.1.0: importing the package from a plain script works. | No extra runtime dependency. The analyzer uses erasable TypeScript only: `import type` for types, no enums, no parameter properties. |
| F12 | 1.1.0 (`agent-session.js`): `/skill:name args` is expanded inside the user message to `<skill name="..." location="...">body</skill>` followed by the args. A model-initiated load is a `read` (or `bash`) of the `<location>` path listed in the `skills` section, which only carries name, description and location. | Two attribution rules cover skills: a tool result for a listed location, and a user message starting with `<skill name=`. |

## Architecture

```
tools/session-analyzer/
  spec-session-analyzer.md     this file
  src/types.ts                 the data contract below, plain shapes only
  src/load.ts                  file -> Session (header, entries, active branch, request points)
  src/inventory.ts             request point -> Segment[] (context by source)
  src/observables.ts           turn -> Observables; Session -> SessionSummary
  src/rank.ts                  SessionSummary -> bad-signal score, for the labeling pass
  src/sanitize.ts              session -> same-size copy with text bodies replaced
  src/report.ts                JSON out, terminal tables
  src/cli.ts                   `analyze <subcommand>`
  fixtures/build.ts            fixture builder (synthetic JSONL with a chosen shape)
  fixtures/shapes.ts           the named shapes the tests and the CLI demo use
  fixtures/generate.ts         writes shapes to fixtures/*.jsonl; a test keeps them in sync
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
  | "system.preamble" | "system.tools" | "system.rules" | "system.docs" | "system.addendum"
  | "system.project_context" | "system.skills" | "system.cwd" | "system.other"   // other: label = key
  | "tool_description"            // one per tool in force, label = tool name
  | "user" | "assistant.text" | "assistant.thinking" | "assistant.tool_call"
  | "tool_result"                 // label = tool name, or skill:<name> for a skill file
  | "custom_message"              // label = customType
  | "bash_execution"              // `!command` runs, sent as user text
  | "compaction_summary" | "branch_summary";

interface Segment {
  source: SegmentSource;
  label?: string;        // tool name, customType, section key, skill name when derivable
  entryId: string;
  position: number;      // index in the request's message list
  chars: number;
  ageTurns: number;      // turns since the entry was added
}

// load.ts produces these; inventory.ts turns a RequestPoint into Segment[].
interface RequestPoint {
  index: number;
  turnIndex: number;           // a turn starts at every user message on the active branch
  assistantEntryId: string;
  timestamp: string;
  provider: string;
  model: string;
  thinkingLevel?: string;      // from the message, else the last thinking_level_change before it
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number };
  stopReason: string;
  textChars: number;           // visible text in the assistant message
  thinkingChars: number;
  toolCalls: { id: string; name: string; argsHash: string; path?: string; args: object }[];
  toolResults: { id: string; name: string; entryId: string; chars: number; isError: boolean; text: string }[];
  context: { entries: SessionEntry[]; messages: AgentMessage[]; sourceEntryIds: string[] };  // pi's projection
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

Attribution rules as implemented in `inventory.ts` (settled against pi 1.1.0 source, F3 and F12):

- System: every system message in the context is replayed in order; each section in force is one
  segment (`system.<key>` for the keys pi writes, `system.other` with the key as label for
  extension sections, label `content` for free-form system text). `AGENTS.md` and the other
  context files sit in `system.project_context`.
- Tool descriptions: one segment per tool in force after the replay, label = tool name, chars =
  description plus the JSON of the parameter schema. These are the segments most likely to
  surprise.
- Skills: the `skills` section lists name, description and location. A `read` of a listed
  location (or a bash command naming it) makes that tool result `tool_result` with label
  `skill:<name>`; a user message starting with `<skill name=` (the `/skill:` expansion) is
  `user` with the same label.
- Thinking: `assistant.thinking` from `thinking` blocks, whenever the provider persisted them.
- `ageTurns` is the request's turn minus the turn in which the segment's entry was added; for a
  compaction checkpoint and summary that is the compaction entry's turn.
- Shares are chars over the request's total chars; `~tokens` is share × usage context tokens.

Three things this layer shows without any attribution method:

- Absence: a rule compacted away, a tool result truncated before the relevant line, a skill never
  loaded, an `AGENTS.md` from a different cwd.
- Duplicates and conflicts: the same instruction in `AGENTS.md`, a skill and the prompt.
- Proportion and position: how much is tool descriptions and skills versus hand-written text, and
  where each rule sits in the window.

## Findings

Surprises so far, from the source and the fixtures; the real-file run will add to this list.

- X1 Tool descriptions dominate a small context: with pi's four default tools and this repo's
  `AGENTS.md`, the fixtures put about half of the characters of a short request into
  `tool_description`, ahead of `system.skills` and `system.project_context`. On real sessions
  with `dd-pup-pi` and MCP tools loaded, the first thing to read off `inventory <dir>` is this
  share, since nothing hand-written competes with it.
- X2 A compaction written by a pi version that stored no `systemMessage` checkpoint leaves the
  projection without any system message, although the live request had one (pi rebuilds the
  prompt at runtime). The inventory under-reports the system part for such sessions; `inspect`
  shows `compactions` with `hasSystemMessage` so they can be told apart.
- X3 Sub-run children are a separate population under `~/.pi/pi-sub-runs`, so a directory
  summary over `sessions/` alone misses 25 of the audit's 40 sessions. Pass both roots.
- X4 A `custom_message` and a `bashExecution` do not start a turn: turn boundaries are user
  messages only. A steer typed while the agent runs does start one, which is the intended
  reading (a new instruction), but it splits one agent run across two turn rows.

## Observables (step 3)

All structural. No model calls. Per turn unless marked. A turn is the span from one user
message to the next on the active branch; `observables.ts` keeps every cue list, pattern table
and threshold in one place at the top of the file.

| Kind | Definition | Source in file |
| --- | --- | --- |
| `asked_question` | assistant text ends the turn with a question and no tool call | assistant content, `stopReason` |
| `tool_calls` | count by tool name | assistant `toolCall` blocks |
| `files_read`, `files_edited` | distinct paths from `read`, `edit`, `write` arguments | tool call args |
| `edit_churn` | same file edited more than once in a turn (+1 per repeat), or an edit whose old and new text swap an earlier edit's on that file (+1) | tool call args |
| `tests_run` | bash command matching a test runner (`vitest`, `jest`, `pytest`, `npm test`, `go test`, `cargo test`); keep the list in one table | bash args |
| `tool_error`, `error_run` | `isError` results by tool; the longest run of consecutive error results in the turn (`error_run` finding from 3); error texts equal to an earlier one in the session (`repeatedErrorText`); `bash`/`powershell` errors are the audit's "failed commands" | tool results |
| `missing_path_error` | error text matching no-such-file patterns | tool results (audit finding 3) |
| `repeated_identical_call` | same tool and same `argsHash` (arguments with keys sorted) as an earlier call in the session; "immediate" when the previous tool call of the same turn was the identical one, so a user asking again is not a blind retry | tool calls (audit: 55 cases) |
| `error_follow_up` | for each tool error, what the next request of the turn did: `identical` (same tool, same arguments), `sameTarget` (same tool, same path, changed arguments), `otherTarget` (same tool, another path or command: the path guessing of audit finding 3), `otherTool`, `none` (the agent stopped or asked); finding when identical or other-target follow-ups occur | tool calls and results |
| `reread_after_compaction` | `read` of a path that was read before the latest compaction on the branch; it also counts as a `repeated_identical_call` when the arguments match | tool calls, compaction |
| `stale_file_in_context` | at the turn's last request: paths with a successful `read` result still in pi's projection that an `edit` or `write` followed; a context edit that drops the result clears it | request context, tool calls |
| `text_before_first_tool` | chars of assistant text preceding the first tool call | assistant content |
| `narration_only` | turn with no tool call and no question | assistant content |
| `long_response` | assistant messages whose visible text is over 2,000 and over 5,000 chars, counted per message | assistant content (audit metric) |
| `correction_turn` (user) | user message of at most 300 chars opening with a cue from `CORRECTION_CUES` (no, not, don't, stop, wait, actually, I meant, that's not, wrong, undo, revert, instead, why did you, you didn't), after a turn with at least 3 tool calls, 1,000 chars of final text or a long response | user content |
| `rewind` | abandoned branches forking from an entry of the turn (children of one `parentId` that are not on the active branch); `branch_summary` entries are counted separately so a rewind with a summary is one rewind | tree |
| `aborted` | `stopReason` aborted or error | assistant |
| `cache_hit_ratio` | `cacheRead / (input + cacheRead + cacheWrite)` per request; the turn reports its minimum and the number of drops of 50 points or more between adjacent requests (across turn boundaries too) | usage |
| `model_change`, `thinking_change` | entries of those types in the turn; the session counts every entry, including turn 0 setup | entries |
| `injection` | `custom_message` by `customType`, chars | entries |

Session summary: counts of the above, cost (assistant requests; compaction, branch summary and
usage entries are `otherCost`), turns, compactions and `tokensBefore`, peak context, forks,
duration, model mix, and cost share of the most expensive requests. Directory summary: the
August audit's quantitative section, computed. The acceptance run for step 3 is

```
npm run analyze -- summary ./sessions ~/.pi/pi-sub-runs --model gpt-5.6 --until 2026-08-13 --exclude <audit session>
```

with this mapping to the audit's numbers: assistant turns = `requests` of the `gpt-5.6-*` rows
of the model mix; recorded cost = `cost`; cost concentration = `topSessionCostShare` and
`top5SessionCostShare`; tool errors by tool = `toolErrorsByName`; missing-path = 
`missingPathErrors`; failed commands = `failedCommands`; immediate identical repeats =
`immediateRepeats`; compactions = `compactions`; 314k = `peakContextTokens`; responses over
2,000 and 5,000 chars = `longResponses` and `veryLongResponses`. `--model` keeps whole sessions
that contain the model, as the audit did ("40 sessions containing GPT-5.6 responses"). `--until`
shows every session as it was at that time (the file truncated there, so later growth, forks and
compactions do not exist yet); `--since` keeps only the requests at or after the cut.

**Acceptance run, 2026-10-11, first attempt** (before `--until` truncated files; it filtered by
session start). Two numbers matched exactly: the largest context (314k) and the most expensive
session ($71.50, the audit's 47.9% of $149.38). The rest did not, for three reasons:

| Audit | Analyzer | Cause |
| --- | --- | --- |
| 40 sessions: 15 interactive, 25 sub-runs | 17, all under `sessions/`, 0 under `~/.pi/pi-sub-runs` | The August sub-runs are no longer in the run dir. The 17 include the audit session itself (`--Users-laurenz-.pi--/2026-08-12T09-02-50…`), which `--exclude` removes. |
| 2,047 turns, $149 | 2,071, $194.64 | Sessions that started before Aug 13 kept growing after the snapshot (the $52.31 session was at most about $25 on audit day). Fixed: `--until` now truncates. |
| Sol 1,159, Terra 664, Luna 224 | Sol 1,727, Terra 314, Luna 5 | Both causes above: the missing sub-runs carried most Luna and Terra turns, later growth added Sol turns. |
| 2 compactions | 10 | Compaction was enabled on Aug 12 near 250k; the sessions compacted after the snapshot. Fixed by truncation. |
| 40 edit errors; 11 responses over 5k | 7; 3 | Mechanical edits and long final reports were sub-run work. |
| 55 immediate identical repeats | 93 | Definition: see the second run. |

**Second run, same day, with `--until` truncating and the audit session excluded** (16 sessions,
1,644 requests, $158.98 of which $154.34 GPT-5.6):

| Audit | Analyzer | Reading |
| --- | --- | --- |
| Sol 1,159, Terra 664, Luna 224 | Sol 1,300, Terra 314, Luna 5 | Sol is +141 turns and +$11: the `2026-08-12T08-15` session (307 requests, 2 compactions) was running while the audit was written. The audit session started at 09:02, so the exact snapshot is `--until 2026-08-12T09:02:50Z`. Terra −350 and Luna −219 are the 25 sub-runs. |
| 2 compactions | 4 | The same running session; both of its compactions came after 09:02. |
| 200 errors (79 read, 76 bash, 40 edit) | 134 (67, 60, 7) | The sub-runs did the mechanical edits: 33 of the 40 edit errors are theirs. |
| 73 missing-path | 79 | `MISSING_PATH_PATTERNS` is wider than `ENOENT`. |
| 55 "immediately repeated an identical tool call" | 0 identical retries after an error; 74 immediate repeats of successful calls | Real agents do not retry an error with the same arguments; after an error the next call changes `oldText` or guesses a new path, and the 74 are polling (`cmux read-screen`, sleeps). The audit must have matched on tool or file. Replaced by `errorFollowUps`: for every error, whether the next request was identical, the same tool on the same path, the same tool elsewhere, another tool, or nothing. The audit's 55 should reappear as identical + same target + other target. |

The 25 August sub-runs are gone: `list ~/.pi --until 2026-08-13` finds no session outside
`agent/sessions` for that period, so their run dirs were deleted with the sessions inside. The
sub-run part of the audit cannot be reproduced. If sub-runs are to be audited again, `sub` must
copy `session.jsonl` out of the run dir before cleanup (a one-line change for step 4 to decide).

**Third run, exact snapshot** (`--until 2026-08-12T09:02:50Z`, the audit session's start,
`--exclude 2026-08-12T09-02-50`): 15 sessions, which is the audit's 15 interactive ones. The
analyzer's GPT-5.6 figures plus the audit's own numbers for the 25 sub-runs reconcile to the
audit exactly:

| Metric | Audit | Analyzer | Difference = the 25 sub-runs |
| --- | --- | --- | --- |
| GPT-5.6 turns | 2,047 | 1,378 (Sol 1,077, Terra 296, Luna 5) | 669 (Sol 82, Terra 368, Luna 219) |
| GPT-5.6 cost | $149.38 | $136.15 | $13.23 |
| Top session | $71.50, 47.9% | $71.50, 50.8% of the interactive total; 47.9% of $149.38 | denominator only |
| Top five | 81.1% = $121.1 | 85.9% = $120.9 | same five sessions |
| Compactions | 2 | 2 | none |
| Largest context | 314k | 314k | none |
| Tool errors | ~200 (79 read, 76 bash, 40 edit) | 133 (68, 60, 7) | ~67, of which 33 edit |
| Failed commands | 70 | 58 | 12 |
| Missing-path | 73 | 80 | pattern table wider than `ENOENT` |
| "Immediately repeated an identical tool call" | 55 | 54 immediate identical repeats | matches: the audit's metric was immediate identical repeats of any call |
| Responses over 2,000 / 5,000 chars | 52 / 11 | 37 / 3 | 15 / 8, the children's final reports |

Step 3's acceptance holds for everything on disk; every residual is the deleted sub-run
population. Three things the run adds to the audit:

- The 55 were not error retries. After an error the next request was: 0 identical, 8 same
  target, 72 other target, 20 other tool, 33 none. The immediate identical repeats are
  successful calls repeated (polling with `cmux read-screen` and sleeps, audit finding 10). The
  audit's finding 6 ("exact edits are retried blindly") is not in the data as identical retries;
  it is the 8 same-target variants.
- Of 80 missing-path errors, the next request guessed another path far more often than it
  listed the directory (see `missingPathFollowUps` in the summary). That is the baseline for the
  `AGENTS.md` rule "never guess filenames after a missing-path error" added on 2026-08-12, and
  `summary ./sessions ~/.pi/pi-sub-runs --since 2026-08-13` gives the after. This is the first
  rule-heatmap cell (deferred section) and costs one command.
- `correction_turn` found 0 in the 15 sessions, while the audit's finding 7 describes two user
  corrections. Either the cues miss how this user corrects, or the turns before were short.
  Step 4 should note the wording of real corrections and extend `CORRECTION_CUES`.

Still open: five sessions from March 2026 record zero cost for every request (the 738-request one
among them), so cost was not recorded by the pi version of that time; cost totals that include
March undercount.

`rank.ts` scores a session for the labeling pass: a plain sum of `correction_turn`, `rewind`,
`error_run` (turns with 3 or more consecutive errors), `repeated_identical_call` and `aborted`,
each as a rate per 100 requests (the denominator floored at 20 requests) divided by the 90th
percentile of that rate over the sessions being ranked and clipped to 1, plus peak context over
200k in units of 100k, clipped to 1. The first real run (2026-10-11) showed why rates: with
fixed caps on raw counts, every session above about 300 requests saturated rewinds, repeats and
aborts, and the ranking was by length. The second run showed why the floor: a four-request
session with one abort was a 25% rate and led the list. Repeats per request dominate the real
ranking and are mostly polling, so the labeling pass should say whether that signal is quality
or only cost; the most expensive sessions since August do not rank high by rate and have to be
labeled on cost alone. The formula is a starting point and lives in one function with a
comment that says so.

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
| 1 | `load.ts`, `cli.ts` with `list <dir>` and `inspect <file>`; dependency and config changes; fixture builder and first fixtures; conformance test against pi's own projection | `npm run analyze -- inspect <file>` prints one row per request point with turn, model, context tokens from `usage`, tool call count. Open questions Q1 to Q5 answered in this spec. Done 2026-10-11 except the real-file run. |
| 2 | `inventory.ts`; `inventory <file> [--turn N]` and `inventory <dir>` | For any session: "what filled the window at turn N" and for a directory: average share by source. First surprises written to the Decisions or a new "Findings" section. Done 2026-10-11 on fixtures. |
| 3 | `observables.ts`, `rank.ts`; `summary <file>`, `summary <dir>`, `rank <dir>` | Per-turn table has the observables as columns. Directory summary reproduces the August audit's numbers for its period within rounding. Code done 2026-10-11; the reproduction run is pending (see "Observables"). |
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

## Open questions (settled against pi 1.1.0 source on 2026-10-11; real-file check pending)

`inspect <file>` prints one line per question before its table, so the first run on real files
confirms or corrects each answer.

- Q1 `AGENTS.md` and the other context files land in the `project_context` section, each file
  wrapped as `<project_instructions path="...">...</project_instructions>`. The key set is
  decided by the pi version that wrote the session; for 1.1.0 it is the list in F3. Which other
  key sets exist in `sessions/` is unverified: `inspect` prints the keys at the last request.
- Q2 Thinking is persisted as `thinking` content blocks (`thinking` text, optional
  `thinkingSignature`, `redacted`) whenever the provider returns them; a redacted block has no
  text. Which providers return text is unverified: `inspect` prints thinking characters per
  provider and model.
- Q3 Sub-run children are not in `sessions/`: `sub` starts them on
  `~/.pi/pi-sub-runs/<run>/session.jsonl` and writes the parent's session id to `<run>/parent`.
  The header's `parentSession` appears only for `/fork`, `/clone` and `newSession({ parentSession })`.
  Parent and child link through `<run>/parent` = the parent header's `id`. The CLI takes several
  roots, so pass both directories. Unverified against real run dirs.
- Q4 pi 1.1.0 knows versions 1, 2 and 3 and `migrateSessionEntries` upgrades 1 to 2 (assigning
  random ids, so a v1 file is not stable across loads) and 2 to 3 (`hookMessage` role becomes
  `custom`). Which versions exist in `sessions/` is unverified: `inspect` and `list --json` print
  the version.
- Q5 Two ways only: the model reads the `<location>` path listed in the `skills` section (a
  `read` or `bash` tool result), or the user types `/skill:name`, which inlines
  `<skill name="..." location="...">` into the user message (F12). Attribution: a tool result
  for a listed location is `tool_result` with label `skill:<name>`; a user message starting with
  `<skill name=` is `user` with label `skill:<name>`.
