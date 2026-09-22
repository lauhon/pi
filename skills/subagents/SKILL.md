---
name: subagents
description: Delegate work to interactive pi subagent children running in tmux with fresh context and cheap models. Use when a task benefits from parallel exploration, review fanout, isolated research, script/migration execution, or offloading context-heavy work to save the main session's context and cost.
---

# Subagents (tmux + pi)

Spawn **interactive** pi children via the `sub` helper script. A child is a
live pi TUI in a detached tmux session (`-L pi-sub`) — not a one-shot `pi -p`
run. It stays up after finishing your task: resume it, or a human can jump in
and drive it directly, without disturbing the parent. Children always start
with **fresh context** — they know nothing except their task prompt.
Everything lives under `~/.pi/pi-sub-runs/<timestamp>-<name>/`.

Script: `~/.pi/agent/skills/subagents/sub` (invoke with absolute path).

**Session scoping**: runs are tagged with the pi session that spawned them
(via `PI_SUB_PARENT`, set automatically by the subagents-monitor extension).
All commands (`list`, `wait`, `out`, `resume`, `kill`, `clean --all`) only see
this session's children — other sessions' runs are invisible and a completion
message you receive always refers to a child you spawned. In a bare terminal
(no pi session) `sub` sees all runs.

```
sub spawn <name> [opts] <task> | -f <file>   # spawn, returns immediately
sub list                                     # status of all children
sub open <name>                              # attach to a child (new cmux tab); respawns if closed/dead
sub resume <name> <message>                  # follow-up turn, same child session
sub wait [name...] [--timeout <secs>]        # block until the turn you asked for settles
sub out <name>                               # print result
sub peek <name>                              # tail output of a running child
sub stop <name>                              # abort the child's current turn, keep it alive
sub kill <name> [--force]                    # end the child gracefully (or force-kill)
sub orphans [--kill]                         # children whose parent lease has expired
sub clean [--all]                            # remove old run dirs
```

## Child lifecycle and states

A child is not "running" or "done" the way a one-shot process is — it stays
alive, idle, waiting for the next turn. `sub list` and the parent widget show:

| State | Meaning | You can... |
|---|---|---|
| `starting` | tmux session up, pi not ready yet | wait, or `sub open` to watch it boot |
| `running` | mid-turn (yours, or a human's) | `sub open` to watch, `sub stop` to abort |
| `blocked` | waiting on an extension prompt — **needs a human** | `sub open` and answer it |
| `idle` | settled, inbox empty, nothing pending | `sub resume`, `sub open`, or leave it |
| `beaconless` | tmux alive but the beacon never loaded (bad path/syntax) | `sub open` and drive it by hand; `resume`/`kill` fall back to paste/Escape |
| `closed` | clean exit (`kill`, `/quit`, idle TTL) | `sub open`/`sub resume` respawns it on the same session file |
| `dead` | tmux gone, not a clean exit (crash, `--force` kill) | same as `closed` — respawnable, `sub` just doesn't call it clean |

`closed` and `dead` are both jumpable; respawning costs one pi startup and
picks the same `session.jsonl` back up, so the idle TTL (default 30 min) is
cheap to hit. Idle TTL never fires while a human is attached or the child has
undrained work.

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

`--cwd` must not be `~/.pi/agent` (or any directory inside it): with that cwd
pi resolves `-e` extension imports against the agent dir's own `node_modules`,
which lacks `@earendil-works/pi-coding-agent`, so every extension — including
the beacon — fails to load. `sub spawn` refuses this with an explanation; use
a scratch `--cwd` and edit the agent dir by absolute path instead.

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
2. **Continue independent work instead of blocking**; do not use tight `sleep`/`list`/`peek` polling loops. In interactive pi sessions the monitor extension wakes you automatically when a child's turn settles, so `wait` is only needed in bare terminals or when you truly have nothing else to do.
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
- After collecting results, `clean` old dirs occasionally.

## Notifications (what the parent hears, and when)

The subagents-monitor extension watches run dirs and decides whether — and
when — the parent hears about a settled turn, keyed on **who caused it**:

- **You asked** (a `sub resume`/`spawn` turn, or one where you and a human
  both contributed) → a `[subagent] ... finished a turn` message arrives
  immediately, `deliverAs: steer`. If you were idle, it also **triggers a
  turn automatically** so you resume the delegated work without being
  prompted. Turns settling within ~4s of each other are batched into one
  message. Set `PI_SUB_AUTOCONTINUE=0` to disable the auto-trigger (the
  notification still arrives, delivered on your next turn).
- **A human steered the child directly** (attached via `sub open` and typed
  into it) → nothing arrives right away. After the human stops typing for
  10s, you get **one** note with the verbatim text of what they said, the
  child's current state, and its output/session paths. This never triggers a
  turn on its own — read it when you get to it.
- **Neither** (an auto-compaction retry, an extension-triggered run with no
  new user message) → silent.

On such a wake-up: read every reported output file, verify/inspect changes,
and continue the task the children were spawned for; only reply with one
short line if nothing was actually pending on them.

The widget also flags two things a poll can't safely stay silent about:
`blocked` (the child is waiting on an extension prompt and needs a human —
`sub open` it) and a **stuck tool call** (a tool that has been running for
several minutes with no result — the widget names it, e.g. an unbounded
`find /`). A `running` child that's merely waiting on the model (normal at
high context, often 1-3 minutes) shows "waiting on provider" and never
notifies — that's not a stall, it's a provider call in flight.

## Context, compaction, and resume discipline

Pi auto-compaction remains enabled in children even though `sub` launches
with `--no-extensions --no-skills` (plus the beacon, loaded explicitly). The
full `session.jsonl` always retains old entries, so its file size is **not**
the active model context.

The subagent widget distinguishes:

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

- Follow-up on an idle child (keeps its compacted session context):
  `sub resume review-tests "Also check the e2e specs under tests/e2e."`
- **A human can watch or take over a live child**: `sub open <name>` (or
  `/sub open <name>` inside the parent session, or the bare `/sub open` picker).
  This opens a new cmux tab attached to the child's tmux session
  (`tmux -L pi-sub attach -d -t <session-name>`, printed if cmux isn't
  available). Typing into it is a normal turn from the child's point of view;
  the parent is told about it only via the debounced note above, never by
  key injection or session surgery.
- Child sessions persist at `<run-dir>/session.jsonl` and can be opened later
  with `pi --session <run-dir>/session.jsonl` if the run dir has been cleaned
  up (rare — `sub clean` only removes `closed`/`dead` runs).
- `sub orphans` lists (or `--kill`s) children whose parent session has gone
  away — they keep running by design (decision: children outlive their
  parent), so sweep them deliberately rather than relying on the TTL alone.
