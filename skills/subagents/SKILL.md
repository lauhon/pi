---
name: subagents
description: Delegate work to parallel or single headless pi subagents running in tmux with fresh context and cheap models. Use when a task benefits from parallel exploration, review fanout, isolated research, script/migration execution, or offloading context-heavy work to save the main session's context and cost.
---

# Subagents (tmux + pi)

Spawn detached `pi -p` child runs via the `sub` helper script. Children always
start with **fresh context** — they know nothing except their task prompt.
Everything lives under `~/.pi/pi-sub-runs/<timestamp>-<name>/`.

Script: `~/.pi/agent/skills/subagents/sub` (invoke with absolute path).

**Session scoping**: runs are tagged with the pi session that spawned them
(via `PI_SUB_PARENT`, set automatically by the subagents-monitor extension).
All commands (`list`, `wait`, `out`, `resume`, `kill`, `clean --all`) only see
this session's children — other sessions' runs are invisible and a completion
message you receive always refers to a child you spawned. In a bare terminal
(no pi session) `sub` sees all runs.

```
sub spawn <name> [opts] <task> | -f <file>   # async spawn, returns immediately
sub list                                     # status of all children
sub wait [name...] [--timeout <secs>]        # block until done (default 600s)
sub out <name>                               # print result
sub peek <name>                              # tail output of a running child
sub resume <name> <message>                  # follow-up turn, same child session
sub kill <name>                              # stop a child
sub clean [--all]                            # remove old run dirs
```

## Role → model defaults

Pick the cheapest model that fits the job. Pass via `--model`:

| Role | Model | Notes |
|------|-------|-------|
| Recon / simple lookups / summaries | `github-copilot/gpt-5.6-luna` | default, very cheap |
| Implementation (code changes) | `github-copilot/gpt-5.6-terra` | |
| Review / planning | `github-copilot/opus-5` | combine with read-only tools |
| Research (web) | `github-copilot/gpt-5.6-sol` | needs web extension, see below |
| Ops / script & migration execution (prepare, run, test DB migrations, heavy bash work) | `github-copilot/gpt-5.6-sol` | best at executing scripts |

Registry warnings like `Model "..." not found ... Using custom model id` are harmless.

## Spawning

Write **self-contained task prompts** — the child has zero context. Include:
concrete goal, relevant file paths, constraints, and the expected output shape.
For non-trivial tasks write the prompt to a temp file and use `-f`.

Single child:

```bash
"$HOME/.pi/agent/skills/subagents/sub" spawn auth-recon --cwd /path/to/repo \
  "Map the auth flow in this repo. List key files with one-line roles. End with a short summary."
```

Parallel fanout (spawn all, then wait once):

```bash
S="$HOME/.pi/agent/skills/subagents/sub"
$S spawn review-correctness --cwd "$PWD" --model github-copilot/gpt-5.5 \
  --tools read,grep,find,ls -f /tmp/task-correctness.md
$S spawn review-tests --cwd "$PWD" --model github-copilot/gpt-5.5 \
  --tools read,grep,find,ls -f /tmp/task-tests.md
$S wait review-correctness review-tests
$S out review-correctness
$S out review-tests
```

## Required lifecycle

Use this lifecycle for every delegated task:

1. **Spawn** with a self-contained prompt and explicit output shape.
2. **Continue independent work instead of blocking**; do not use tight `sleep`/`list`/`peek` polling loops. In interactive pi sessions the monitor extension wakes you automatically when children finish, so `wait` is only needed in bare terminals or when you truly have nothing else to do.
3. **Read the completion output** with `sub out <name>` or the reported out-file path.
4. **Inspect relevant changes** yourself for writer subagents.
5. **Verify** with the appropriate project checks before reporting completion.
6. **Report only completed facts**. If the child is still running, say only that it is asynchronous; never imply its result was reviewed.

Completion notifications are status signals, not review. Always read the output before using or reporting a child's conclusions. A child may not share the parent's cmux surfaces, shell state, credentials, or running processes; include required access/setup explicitly or keep those operations in the parent.

## Key rules

- **Read-only children** (reviewers, scouts that must not touch files): pass
  `--tools read,grep,find,ls`. Also state "do not modify files" in the prompt.
- **One writer at a time**: never run two children that edit the same worktree
  concurrently. Parallelize reads/reviews, not writes.
- **Research children** need web tools (extensions are off by default):
  `--ext ~/.pi/agent/npm/node_modules/pi-web-access/index.ts`
- **Thinking** defaults to `off` for cost. Raise per child with
  `--thinking medium` only when the task genuinely needs it.
- `wait` prints each child's out-file path; read the file, don't re-run the child.
- In interactive pi sessions, the subagents-monitor extension shows live child status and, when children complete, injects a `[subagent] ... finished` message. Completions landing within ~4s are batched into one message, and if the parent is idle the message **triggers a turn automatically** — so you resume the delegated work without the user prompting you. On such a wake-up: read every reported output file, verify/inspect changes, and continue the task the children were spawned for; only reply with one short line if nothing was actually pending on them. Set `PI_SUB_AUTOCONTINUE=0` to disable the auto-trigger (notification still arrives, delivered on the next turn).
- After collecting results, `clean` old dirs occasionally.

## Context, compaction, and resume discipline

Pi auto-compaction remains enabled in headless children even though `sub` launches
with `--no-extensions --no-skills`. The full `session.jsonl` always retains old
entries, so its file size is **not** the active model context.

The subagent monitor distinguishes:

- `ctx~N`: approximate current context from the latest model call.
- `ΣN tok`: cumulative session throughput. This repeatedly counts cached prompt
  tokens on every model/tool step and can be orders of magnitude larger than the
  live context.
- `cN`: number of automatic compactions recorded in the session.

Use `resume` only for a tightly related correction where the child's prior file
map and decisions materially help. A resume keeps the same logical session and
its compacted history; it does not create fresh context.

Prefer a **fresh spawn with a self-contained checkpoint prompt** when:

- crossing a major phase or topic boundary;
- the child has already had roughly 3–4 corrective turns;
- previous exploration read many files irrelevant to the next task;
- a concise prompt can preserve the needed decisions more cheaply than replaying
  the existing session.

Auto-compaction is the safety net for long single tasks, not a reason to reuse one
child indefinitely. No manual compaction is normally needed.

## Steering & observing

- Follow-up on a finished child (keeps its compacted session context):
  `sub resume review-tests "Also check the e2e specs under tests/e2e."`
- A human can watch/take over a live child: `tmux -L pi-sub attach -t <session-name>`
  (session name = run dir basename, shown by `spawn` and `list`).
- Child sessions persist at `<run-dir>/session.jsonl` and can be opened
  interactively later: `pi --session <run-dir>/session.jsonl`.
