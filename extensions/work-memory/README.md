# work-memory

> Last reviewed: 2026-11-24 · Owner: @laurenz

A short log of work items across all repos: what you worked on, where it ended, what is left. pi builds it from finished sessions in the background and shows the open items to the agent at session start.

## Data

Everything is in `~/.work-memory/` (`WORK_MEMORY_DIR` overrides). The files are plain, so another harness only has to read `items.jsonl`.

| File | Content |
| --- | --- |
| `items.jsonl` | One item per line: `id, title, status, done, cwd, links[], created, updated, keepUntil?`. Hand edits are fine; a broken line is skipped. |
| `processed.json` | Session file → size when processed. A session that grows (resumed later) is processed again. |
| `backfill-done` | Present after the first full run. Before it exists, runs use `backfillModel`. |
| `config.json` | Optional overrides, see below. |
| `lock` | Held while a run is active, so two pi windows don't process the same sessions. |

`created`/`updated` are the date of the session, not of processing. Items drop 60 days after `updated` unless `keepUntil` is set (a date or `"forever"`).

## How it runs

1. `session_start` renders the index once and adds it as the `work_memory` system prompt section. It stays fixed for the session, so the prompt cache holds. About 15 lines: open items in this repo, open items elsewhere, items finished in the last 7 days.
2. In the background it finds sessions in `~/.pi/agent/sessions` that are idle for 30+ minutes, at most 14 days old, and not processed yet. Temp dirs (`--private-tmp*`, subagent children) and the current session are skipped. Children started by `sub` and print-mode runs don't run the writer at all.
3. Each session becomes a digest (user messages, final answers, compaction summaries, git/gh/jira commands; tool output and thinking dropped), usually 0.5–5k tokens. One model call per session returns a JSON array of item changes, applied in order of session age.
4. A notification reports the result, e.g. `work-memory: 3 sessions → 1 new, 2 updated ($0.03)`.

## Agent tool

`work_memory` with `action`:

- `search`: `query`, `cwd`, `includeDone`, `limit` (default 15). Shows the last session file per item, for resuming.
- `update`: `id` (omit to create with `title`), `status`, `done`, `links`, `keepDays` (`-1` forever, `0` clears).
- `logseq_todos`: open `TODO/DOING/LATER/NOW` lines from the Logseq graph, filtered by `query`, `page`, `tag`, `markers`, `limit` (default 20). Newest files first, one line per task.

## Command

- `/work-memory` shows the current index.
- `/work-memory run` processes finished sessions now.

## Config (`~/.work-memory/config.json`)

```json
{
  "writerModel": "anthropic/claude-sonnet-5-5",
  "backfillModel": "anthropic/claude-haiku-5-5",
  "maxAgeDays": 14,
  "minIdleMinutes": 30,
  "logseqDir": "~/Documents/Notes/logseq-notes (absolute path)"
}
```

The Logseq graph lives under `~/Documents`, so macOS needs Full Disk Access for the terminal app running pi, and the app must be restarted after granting it.

## Tests

`pnpm test` in `~/.pi/agent` (vitest). Modules are pure and take an explicit `now`: `store.ts` (items, prune, index), `sessions.ts` (finding and digesting sessions), `writer.ts` (prompt and output parsing), `runner.ts` (one run, lock), `logseq.ts` (task search). `index.ts` only wires them into pi.
