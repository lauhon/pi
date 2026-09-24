# Spec: interactive subagent children

> Status: **Implemented** · 2026-09-22 · supersedes the `pi -p` child model in `sub` + `subagents-monitor.ts`

## Goal

A child subagent becomes a **live pi session you can walk into at any time**. The parent agent and
the human are both clients of the same running session. Jumping in changes nothing about the child's
work; the parent keeps running untouched.

Non-goals: multi-human collaboration on one child, remote children, replacing `sub` for one-shot
fanouts (a `--headless` mode can come back later if fire-and-forget turns out to be missed).

## Verified facts (probed 2026-09-21, not assumptions)

Each of these was executed against a real pi in a detached tmux session before writing this spec.

| # | Fact | Consequence |
| --- | --- | --- |
| V1 | A pi TUI runs fine in a detached tmux session with no client attached (80x24 default, re-renders on attach at the client's size). | Children can be TUIs. |
| V2 | `pi … --name <n> "<prompt>"` in interactive mode submits the prompt at startup. | Available, but **deliberately unused** — see "Turn 1 goes through the inbox". |
| V3 | An extension inside the child can call `pi.sendUserMessage(text)` while idle (triggers a turn) and `{deliverAs:"followUp"}` while streaming (queues, shown as "Follow-up:" in the transcript). | **Parent→child prompting is a file drop, not key injection.** No editor collision, no popup handling, no escaping. |
| V4 | `agent_settled` fires in the child; `ctx.sessionManager.getBranch()` yields the last assistant text. | Beacon can write `out-N.md` and an idle marker. |
| V5 | `tmux -L pi-sub attach` works from another terminal; `#{session_attached}` flips to 1 and back. | Jump-in = attach; attach state is observable for the widget. |
| V6 | `tmux send-keys -l '@/abs/path'` opens the file-completion popup and **eats the first Enter**; `@path` in the TUI is *not* inlined (unlike `-p`), the model reads it with a tool. | Key injection rejected. Also: never plan on `@file` semantics matching `-p`. |
| V7 | `tmux load-buffer` + `paste-buffer -p` inserts multi-line text without submitting; `Escape` aborts a running turn; `-l '/quit'` + Enter quits. | Only kept as a *fallback* path if the beacon is dead (see F4). |
| V8 | Session JSONL records injected messages as ordinary `user` entries with no provenance marker, and `sendUserMessage("text")` is stored as a **content array**, not a string. | Provenance must be recorded by the beacon, and both sides must hash the same normalized form (see "Who typed it"). |
| V9 | A child can run with **no model and no network**: an extension loaded via `-e` calls `pi.registerProvider()` with an in-process `streamSimple`, pointed at a closed port. A real TUI in real tmux then emits real `agent_start` / `agent_settled` / session entries. | The whole control plane is testable deterministically, for free. See "Testing". |
| V10 | `ctx.shutdown()` in interactive mode is **deferred until the agent is idle**, after queued steering and follow-ups. | A naïve "quit, then force-kill after 5 s" would abort real work. See "Stopping things". |
| V11 | `ui_prompt_start` / `ui_prompt_end` fire **only** around extension `ctx.ui.*` calls. Pi has no built-in tool-approval popup. | `blocked` is a real but narrow state — only children loading extensions can enter it. |
| V12 | **Corrected 2026-09-22.** Spawning a child with `--cwd` inside pi's own agent dir (`~/.pi/agent`) breaks **extension resolution**, not the model catalog: pi resolves `-e` extension imports against that dir's `node_modules`, which has no `@earendil-works/pi-coding-agent` (the only copy lives in pi's global install), so *every* `-e` extension silently fails to load. Losing `pi-claude-code-use` makes `anthropic/*` ids fall back to a custom id whose 400k `max_tokens` the API rejects; losing the beacon makes the child unobservable. Proven by running the identical command from `/tmp` (works) and from `~/.pi/agent` (fails). The original "package reconciliation / restricted catalog" reading was wrong and cost two failed children. | `sub spawn` **refuses** an agent-dir cwd and names the cause. Work on the agent dir from a scratch cwd, by absolute path. E24. |
| V13 | pi auto-discovers `extensions/*.ts` and `extensions/*/index.ts`. A `*.test.ts` placed directly in `extensions/` is loaded **as an extension** at session start; importing vitest there throws "Vitest failed to access its internal state" and takes down every extension. | Extension tests live one level down beside an `index.ts`. Enforced by a test (`extensions layout`). |
| V14 | An attached child can't be scrolled with tmux defaults. pi draws in the normal screen buffer (`alternate_on=0`) and doesn't request mouse reporting (`mouse_any_flag=0`), so its output does reach tmux history. But `mouse` defaults to off, so the wheel never gets to tmux, and `history-limit` defaults to 2000 lines. `history-limit` only applies to panes created after it is set. | `skills/subagents/tmux.conf` (mouse on, 50000 lines) is passed with `-f` when `sub` starts the server and re-sourced on every `open`. |

## Architecture

Three parts, each with one job.

```
parent pi session                child run dir                     child pi process
─────────────────                ─────────────                     ────────────────
subagents-monitor.ts    ──┐      <dir>/inbox/NNN.md      ──────►   sub-beacon.ts
  widget, notifications   │      <dir>/control/<verb>    ──────►     (drains inbox,
  /sub open               │      <dir>/state.json        ◄──────      writes state,
                          │      <dir>/out-N.md          ◄──────      owns lifecycle)
`sub` (bash)            ──┘      <dir>/session.jsonl     ◄──────►   pi TUI in tmux -L pi-sub
```

- **`sub`** owns spawning the tmux session and the run dir. It never talks to a live child except by
  writing files.
- **`sub-beacon.ts`** is loaded into every child via `-e`. It is the child's only control surface:
  drains `inbox/`, executes `control/` verbs, writes `state.json` + `out-N.md`, and owns the idle TTL.
- **`subagents-monitor.ts`** stays a read-only observer of run dirs, plus the `/sub` command.

The invariant that makes this safe: **exactly one process ever holds `session.jsonl`** — the child's
own pi. The parent never opens the child's session file for writing, and `sub open` respawns a pi on
it only when no tmux session exists for that run dir (guarded by an atomic `mkdir` lock).

## Child lifecycle

```
                 sub spawn
                     │
                     ▼
   ┌──────────► [ starting ] ──pi ready──► [ running ] ◄──┐
   │                 │                     │    ▲         │ inbox drop /
   │            launch fails    ui_prompt_start │         │ human turn
   │                 │                     ▼    │ answered│
   │                 │                 [ blocked ]        │
   │                 │                          │         │
   │                 ▼                  agent_settled      │
   │             [ dead ] ◄──crash──── [ idle ] ──────────┘
   │                                       │
   │                              idle > TTL, no client
   │                                       ▼
   └──── sub open / sub resume ────── [ closed ]
              (respawn on same session.jsonl)
```

| State | Definition (how it is detected) | Jump-in behaviour |
| --- | --- | --- |
| `starting` | tmux session exists, `state.json` absent | attach (you watch it boot) |
| `running` | `state.json.state == "running"` and tmux session exists | attach |
| `blocked` | `state.json.state == "blocked"` — beacon saw `ui_prompt_start` without a matching `ui_prompt_end` | attach; **the child needs you**, widget flags it |
| `idle` | `state.json.state == "idle"` and tmux session exists | attach |
| `beaconless` | tmux session alive but no `state.json` after 20 s — the beacon failed to load | attach; parent-side control degrades to the F4 fallback |
| `closed` | no tmux session, `state.json.state == "closed"` (clean exit recorded by the beacon) | respawn on the session file, then attach |
| `dead` | no tmux session, last `state.json` was not `closed` | respawn (with a warning), then attach |

`closed` and `dead` are both jumpable; the only difference is whether the parent gets an error notice.
This is what makes the TTL cheap: quitting an idle child costs you one pi startup, never any state.

### What `idle` means exactly

`idle` is **not** "no output for a while" and **not** `agent_end`. It is:

> `agent_settled` has fired **and** `inbox/` holds **no `NNN.md` file at all** **and** the beacon has
> no injection in flight **and** no UI prompt is open.

The inbox condition is deliberately stricter than "nothing left to inject". If the rename to `.sent`
fails (E14: read-only or vanished run dir) the beacon believes the file is drained while the parent
still sees a queued turn on disk; reaping under that silently drops the turn. Counting *any* `NNN.md`
closes it. A mutation test showed the weaker guard was unobservable.

`agent_settled` is pi's own "I will not continue on my own" signal — it fires after automatic
retries, after auto-compaction retries, and after queued follow-ups are exhausted (`agent_end` fires
earlier and can be followed by more work, so it is the wrong signal). The extra three conditions
close real races:

- **Injection window.** Between the beacon reading an inbox file and pi emitting `agent_start`, the
  last signal seen is still `agent_settled`. The beacon therefore flips `state.json` to `running`
  *synchronously at injection time*, before calling `sendUserMessage`. Without this, `sub wait`
  returns for a turn that has not started.
- **Undrained inbox.** A child with a queued turn is not idle even if it is momentarily settled.
- **Blocked on a prompt.** A child waiting on an extension dialog has stopped producing output but is
  not idle and must never be reaped — it is `blocked`. `blocked` also **outranks a settle**: if
  `agent_settled` fires while a prompt is open the child stays `blocked` until `ui_prompt_end`,
  otherwise a dialog-blocked child would advertise `idle` and become reapable (E22).

The TTL reaps from **`starting`** as well as `idle`, or a child whose turn 1 was rejected sits
forever under the same guards.

Stall detection stays as a separate, weaker signal (no `session.jsonl` writes for 2.5 min) for the
cases the beacon can't see, e.g. a wedged network call.

`idle-N` markers are per turn, so `sub wait` waits for the settle of **the parent's own turn N**, not
for any settle — a human turn landing in between doesn't satisfy a parent's wait (E17).

## Control plane (files, all inside the run dir)

| Path | Writer | Reader | Meaning |
| --- | --- | --- | --- |
| `inbox/<seq>.md` | `sub resume`, `sub spawn` | beacon | a turn to deliver; created with `wx`, renamed to `.sent` after injection (durable: survives a dead child, drained on respawn) |
| `turns.jsonl` | beacon | monitor, `sub` | one append-only record per settle: turn number, origin, user entry ids, inbox seqs covered |
| `control/quit`, `control/abort` | `sub kill`, `sub stop` | beacon | graceful verbs; deleted by the beacon on execution |
| `state.json` | beacon | monitor, `sub` | `{state, turn, since, pid}`; written tmp+rename so pollers never read truncated JSON |
| `out-N.md` | beacon | everyone | last assistant text of turn N |
| `idle-N` | beacon | `sub wait` | turn N settled |
| `parent-alive` | monitor (touch every tick) | `sub orphans` | parent liveness lease; mtime older than 60 s means orphaned |
| `lock/` | `sub` (mkdir) | `sub` | respawn mutex |

Everything is a plain file, so every path works when the child is dead, the parent is closed, or both.

## Message paths

**Parent → child.** `sub resume <name> <text>` writes `inbox/<seq>.md` with `open(…,"wx")` so two
concurrent resumes cannot collide on a sequence number (timestamps are not enough — E3). The beacon
polls the inbox (500 ms), renames the file to `.sent`, and calls
`pi.sendUserMessage(text, streaming ? {deliverAs:"followUp"} : undefined)`. Always follow-up, never
steer — it behaves exactly like typing into a normal session while the agent works. If the child is
`closed`/`dead`, `sub resume` respawns it first and the beacon drains the inbox at startup.

**Turn 1 goes through the inbox too.** `sub spawn` writes the task to `inbox/000001.md` and passes
**no positional prompt**, even though V2 shows one would work. One code path for every turn, and turn 1
gets provenance for free instead of being a special case the beacon never sees. Cost: the first
turn starts up to 500 ms later.

**Human → child.** `sub open <name>` (or `/sub open` in the parent, or clicking through the widget):
opens a **new cmux tab** running `tmux -L pi-sub attach -d -t <session>`. `-d` detaches any other
client so two tabs can't fight over the pane size. If the child is `closed`/`dead`, `sub open`
respawns it on its session file first and then attaches.

**Child → parent.** Unchanged in spirit: the monitor watches run dirs and injects a note. The rules
change (below).

## Who typed it, and what a "turn" is

Session entries carry no provenance (V8). A **set of hashes does not work**: if you type the same
text the parent sent, the hashes collide; duplicate parent injections collapse; and any message not
injected by the beacon would be misread as human. Provenance is therefore **ordered matching**, done
by the beacon, which is the only component that knows what it injected.

The beacon keeps an ordered queue of the messages it has injected but not yet accounted for. At each
settle it walks `getBranch()` from a persisted cursor and, for every new `user` entry:

- normalized text equals the head of the queue → **parent**, pop the head;
- otherwise → **human**.

Order-based matching handles duplicates and identical text correctly. Normalization is one shared
function (concatenate `type:"text"` blocks with `\n`, trim trailing whitespace) used on both sides,
because `sendUserMessage("text")` is persisted as a content array (V8).

**A turn is one `agent_settled` span**, not one message: several queued messages can collapse into a
single settle. The beacon appends one record per settle to `turns.jsonl`:

```json
{"turn":4,"origin":"parent|human|mixed|unknown","userEntries":["e91","e92"],"inbox":[7,8],"out":"out-4.md","ts":…}
```

That record is what everything downstream reads: `sub wait <name>` waits for a record whose `inbox`
covers the highest sequence this parent has written (not for "any settle" — E17), and the monitor's
notification rule keys on `origin` (`mixed` counts as parent, since the parent asked for part of it
and will want to know).

`unknown` exists because a settle can cover **zero** new user entries — an auto-compaction retry or an
extension-triggered run. Attributing that to the human would fire the "you steered this child" note
for something nobody typed, so the monitor stays silent on `unknown`.

## Notification rules (answer to Q4: let the model decide, don't classify)

One rule decides whether the parent hears anything, keyed on the **origin of the turn that settled**:

- Settle caused by a **parent** turn → completion notice as today (`[subagent] 'x' finished …`,
  `deliverAs: "steer"`, auto-continue as today). The parent asked; the parent gets told.
- Settle caused by a **human** turn → nothing immediately. Accumulate. After a 10 s debounce with no
  further human activity, inject **one** note containing the verbatim text of your turns (truncated
  to ~200 chars each), the child's state, and the paths, with `triggerTurn: false`.

```
[subagent] you steered 'logging-impl' directly (3 turns):
  1. "actually skip the ingest package"
  2. "no, keep the trace ids"
  3. "run the typecheck"
Child is idle. out: …/out-4.md · session: …/session.jsonl
```

Adaptive without a threshold to tune: one short question is one short line the parent will ignore; a
long divergence is visibly a long divergence and the parent goes and reads. No extra model call, no
summarizer, no attach/detach hooks in the notification path. Attach state (`#{session_attached}`) is
used **only** as a widget indicator, which keeps the noisy part of tmux out of the logic.

Debounce flush also triggers on state change to `closed`/`dead` so nothing is ever swallowed.

## Stopping things (explicit, because this is where it usually goes wrong)

| Intent | Command | Mechanism | Fallback |
| --- | --- | --- | --- |
| Stop the current turn, keep the child | `sub stop <name>` | `control/abort` → beacon `ctx.abort()` | `send-keys Escape` (V7) |
| End the child, keep it jumpable | `sub kill <name>` | `control/abort`, wait for idle (≤10 s), then `control/quit` → beacon `ctx.shutdown()`, writes `state=closed` | after a further 10 s: `tmux kill-session`. `--force` skips straight to that. |
| End everything for this parent session | `sub kill --all` | loop of the above | — |
| Idle reaping | beacon, `PI_SUB_IDLE_TTL` (default 30 min) | beacon self-quits if idle > TTL **and** no client attached | — |
| Human quits from inside | `/quit` or Ctrl+C in the attached tab | pi exits; beacon's `session_shutdown` writes `state=closed` | tmux session ends → monitor infers `dead` |
| Parent pi exits | nothing automatic | children survive (they are separate processes) | `sub orphans` |

Because `ctx.shutdown()` defers until idle (V10), `sub kill` **aborts first**. Otherwise the force
fallback would fire on exactly the children that are doing the most work.

**Children outlive their parent by design** (decision A): a closed or crashed parent must never
destroy in-flight work. The cost is orphans, so orphan handling is a first-class command rather than
an afterthought:

```
sub orphans            # ignore PI_SUB_PARENT: every live child on the machine,
                       # with its parent session id and whether that parent is still alive
sub orphans --kill     # graceful quit of every child whose parent is gone
```

Liveness is a **lease, not a pid**: the monitor touches `parent-alive` on every tick, and a child is
orphaned when that file is older than 60 s. Pids were the original plan and they don't work — `kill -0`
proves a process exists, not that it is still your parent, and pids are recycled (the old E23). A lease
needs no process introspection and is identical on macOS and Linux.

## Edge-case matrix

Each row is a scenario to walk before implementation is considered done. Rows marked ✅ were already
exercised during probing.

| # | Scenario | Expected |
| --- | --- | --- |
| E1 | `sub resume` while the child is mid-tool-call | queued as follow-up, delivered after the turn ✅ |
| E2 | `sub resume` while a human is attached and half-way through typing | no interference — injection never touches the editor ✅ (this is why V3 beats key injection) |
| E3 | Two `sub resume` calls in the same second | both land as separate inbox files, drained in `sort` order, delivered in order |
| E4 | `sub resume` to a `closed` child | respawn, then the whole inbox is drained in sequence order |
| E5 | `sub open` twice on the same child | second attach uses `-d`, first tab shows "detached"; no size fight |
| E6 | `sub open` on a `closed` child, twice, concurrently | `lock/` mkdir mutex → exactly one respawn, second attaches |
| E7 | Child crashes (OOM) mid-turn | tmux session gone, no `idle-N`, state `dead`, parent notified once |
| E8 | Human aborts a turn with Escape, then walks away | `agent_settled` fires; human-origin settle → debounced note |
| E9 | Human `/quit`s the child while the parent has an undrained inbox | inbox files persist; next `resume`/`open` respawns and drains |
| E10 | Idle TTL expires while a human is attached | no reap (attach check) |
| E11 | Idle TTL expires with an undrained inbox | no reap (inbox check) |
| E12 | Child auto-compacts mid-session | no impact; monitor already counts compactions |
| E13 | Parent session ends and restarts, children still alive | runs are keyed by `PI_SUB_PARENT`; new parent session sees them as orphans (decision A) |
| E14 | Human renames/deletes the run dir under a live child | beacon write fails → log and keep running; `sub` reports missing |
| E15 | Project trust prompt on child start | suppressed with `-a` ✅ |
| E16 | Beacon fails to load (syntax error, bad path) | child still usable interactively; `sub` detects missing `state.json` after N s and reports `beaconless` — parent-side `resume` falls back to paste+Enter (V7) |
| E17 | `sub wait` on a child that a human is actively steering | waits for `idle-N` of the *parent's* turn number, not any settle |
| E18 | cmux not running / not installed | `sub open` prints the `tmux -L pi-sub attach -d -t <s>` command to run manually |
| E19 | Non-UTF8 or very large inbox file | beacon caps at e.g. 256 KB and logs a rejection |
| E20 | tmux server dies entirely | all children `dead`; run dirs intact; respawnable |
| E21 | `sub wait` races an injection: inbox drained, `agent_start` not yet fired | beacon marks `running` before injecting → wait does not return early |
| E22 | Child blocks on a tool-approval or extension dialog | state `blocked`, widget flags "needs you", never reaped, no false completion |
| E23 | Orphan detection survives pid recycling | solved by construction: liveness is the `parent-alive` lease, no pid is consulted |
| E24 | `sub spawn --cwd ~/.pi/agent` (or any pi agent dir) | refuse with an explanation — package reconciliation there breaks model resolution (V12) |
| E25 | Human types the exact text the parent just injected | ordered matching attributes them correctly, one parent + one human |
| E26 | Several queued messages collapse into one `agent_settled` | one `turns.jsonl` record, `origin: "mixed"`, `inbox` listing every covered sequence |
| E27 | Poller reads `state.json` mid-write | impossible: tmp+rename; readers additionally tolerate a parse failure and retry |

## How we avoid overlooking a path (method, not vibes)

1. **Every transition in the state machine has a named detector.** The table above lists how each
   state is *observed*, not just what it means. Any state we cannot detect from files is not allowed
   to exist.
2. **Cross-product review**: 5 states × {`resume`, `open`, `stop`, `kill`, `wait`, TTL, crash, human
   quit}. The matrix above is that cross-product with the uninteresting cells collapsed; any cell not
   represented is a gap to fill before coding.
3. **Executable scenario tests.** See "Testing" below. Because of V9 these run with no model and no
   network, so they are cheap enough to be the primary safety net rather than a release ritual.
4. **Fault injection for the file plane.** Because the whole control plane is files, the nasty cases
   are cheap to force: delete `state.json`, hold `lock/`, drop a 0-byte inbox file, `chmod -w` the run
   dir. Each must degrade to "child keeps working, `sub` reports clearly".
5. **One-writer audit.** Before merge, grep for every path that opens a child `session.jsonl` and
   assert there is exactly one writer. This is the only failure mode that corrupts data rather than
   annoying the user.

## Testing

Design for testability is part of the work, not a follow-up. Three seams:

- **Beacon** = a pure reducer `(BeaconEvent, BeaconState) -> [BeaconState, BeaconEffect[]]` plus a
  thin pi adapter. Events: `poll`, `agentStart`, `agentSettled`, `uiPromptStart/End`,
  `sessionShutdown`. Effects: `writeState`, `renameInbox`, `appendTurn`, `sendUser`, `abort`,
  `shutdown`, `writeOutput`, `touchIdle`. Every ordering rule, the idle predicate, TTL guards and
  provenance matching are then unit tests with injected `now`.
- **`sub`** = a sourceable pure state function over a run-dir fixture (`deriveState(dir, tmuxAlive, now)`)
  plus command adapters behind `TMUX_BIN` / `PI_BIN` / `CMUX_BIN` / `PI_SUB_SOCKET` / `PI_SUB_RUNS`.
- **Monitor** = pure `collectRun` / `classifyTurns` / `transition` / `render`, with filesystem, tmux,
  clock, scheduler and parent-messenger injected. Mutations (`/sub open`, orphan kill) delegate to
  `sub`; the observer core stays read-only.

Layers, and what each costs:

| Layer | Runs | Time |
| --- | --- | --- |
| Pure unit (vitest, fake timers) | reducer, state derivation, classification, render | 1–3 s |
| Filesystem / shell component | temp run dirs, fake `pi`/`tmux`/`cmux` binaries, concurrent resumes | 5–15 s |
| Real pi + **stub provider** (V9) | real session JSONL, real `agent_*` events, no network | 10–30 s |
| Real tmux + stub provider | attach/detach, respawn locking, crash, server death | 30–90 s, capability-gated |
| Real-model smoke | one `claude-haiku-4.5` no-tool turn | pre-release only |

Matrix coverage: E1–E22 and E24–E27 all have an automatable core across those layers. Nothing
requires a paid model in CI. Flakiness is controlled by injecting the scheduler rather than sleeping
(500 ms drain, 2 s monitor tick, 10 s debounce, 30 min TTL all become injected clocks), unique socket
and run-dir names per worker, and `trap` + `afterAll` teardown that kills every tmux server and pi
process the fixture started.

First tests, in order (red first in each case):

1. Beacon injection ordering — `writeState(running)` **before** `sendUser` (E21).
2. The idle predicate — undrained inbox is not idle; open UI prompt is `blocked`.
3. Concurrent inbox allocation and lexical drain order (E3).
4. `deriveState` — `alive:false, recorded:idle` → `dead`; `recorded:closed` → `closed`.
5. `wait` targets the turn covering a specific inbox sequence, not any settle (E17).
6. Ordered provenance matching, including the identical-text case (E25) and the `mixed` settle (E26).
7. Real pi + stub provider: the event sequence `session_start → agent_start → agent_settled → … → session_shutdown`.
8. Concurrent respawn under `lock/` produces exactly one pi process (E6) — from here on it is
   characterization of tmux behaviour rather than strict TDD.

## Beacon contract (frozen, phase 1 — implemented and tested)

`skills/subagents/beacon/` exists: pure `reducer.ts`, adapter `index.ts`, `testing/stub-provider.ts`
(V9), `testing/event-recorder.ts`, 128 passing tests. `sub` must honour this contract.

**Env vars `sub` sets on the child:** `PI_SUB_RUN_DIR` (required — unset means the beacon does
nothing), `PI_SUB_SESSION` (tmux session name; without it the attach probe always answers "not
attached" and an attached child can be reaped), `PI_SUB_SOCKET` (default `pi-sub`),
`PI_SUB_IDLE_TTL` (**seconds**, default 1800), `PI_SUB_POLL_MS` (default 500).

**Files `sub` writes:** `inbox/NNNNNN.md` matching `^\d+\.md$`, opened `wx`. The beacon renames to
`.sent` after injecting, or `.rejected` when >256 KiB, non-UTF8, or blank. `control/abort` and
`control/quit` are empty files, deleted by the beacon on execution; both present in one poll runs
abort first.

**Guarantees the beacon provides:** `state.json` says `running` strictly before `sendUserMessage`
(E21); a file is injected at most once per process even if the rename fails; no reap while a client
is attached, any `NNN.md` is on disk, a UI prompt is open, or the phase is not idle/starting; a
vanishing run dir logs and keeps serving the human rather than killing the child.

**`sub clean` owes the beacon one thing:** nothing sweeps `inbox/*.sent` and `inbox/*.rejected`.

**Turn numbers belong to the run dir, not the process.** A respawn (E4/E6) reuses the same
`session.jsonl`, so the beacon must rehydrate at `session_start`: seed `turn` from the highest turn in
`turns.jsonl` and seed `accounted` with every entry id already in the branch. Starting fresh at turn 0
overwrites `out-1.md`, leaves a stale `idle-1`, writes a duplicate `turn: 1` record, and re-counts the
previous run's user entries so `origin` comes out `mixed` when it was `parent`. Found by smoke test,
not by the phase-1 suite — which never respawned a child.

**The child's stdout must stay on the pane's tty.** `tmux new-session` with the pi command redirected
to a log file makes pi exit immediately and takes the tmux session with it, so the child is `dead`
before the first poll. Use `pipe-pane` to capture output instead (F5).

**Unverified in phase 1, and phase 2 must close it:** the stub provider answers instantly, so
`ctx.abort()` against a genuinely running turn, V10's shutdown deferral, and `#{session_attached}`
detection are all untested. Give the stub an injectable delay — E1 and E8 need it anyway.

## Work breakdown

0. ~~Test harness: stub-provider extension (V9), run-dir fixture builder, teardown discipline.~~ **Done.**
1. ~~`skills/subagents/beacon/`: pure reducer + pi adapter — inbox drain, control verbs, `state.json`,
   `out-N.md`, `turns.jsonl`, ordered provenance, idle TTL with attach+inbox guards.~~ **Done.**
2. ~~`sub` rewrite of `launch`/`status_of`/`out`/`wait`/`resume`/`kill`, new `spawn` (inbox turn 1,
   `--name`, `-a`, `-e beacon`, agent-dir cwd refusal), new `open`, `stop`, `orphans`, `lock/` mutex.~~ **Done.**
3. ~~`subagents-monitor.ts`: new states in the widget + attach indicator, provenance classification,
   the two notification rules, the `parent-alive` lease, and the `/sub` command — `open <name>`
   with `getArgumentCompletions` for Tab completion over this session's children, a picker when
   invoked bare, plus `list`, `stop`, `kill`, `orphans`, `clean`.~~ **Done.** Lives at
   `extensions/subagents-monitor/index.ts` (V13).
4. ~~Scenario suite covering E1–E22, E24–E27 across the layers above.~~ **Done** — 207 tests.

### F4 — beaconless fallback

If a child's tmux session is alive but no `state.json` appears within 20 s, the child is
**`beaconless`**: the beacon failed to load (bad path, syntax error, incompatible pi). The child is
still usable by a human, so it is never killed automatically. The widget flags it, `sub resume` falls
back to `load-buffer` + `paste-buffer -p` + `Enter` (V7), and `sub wait` refuses rather than hanging.
5. ~~`SKILL.md`: new model, delete the false "tmux attach to watch a child" line, document that
   `--headless` does not exist yet.~~ **Done.**

### Known gaps (2026-09-22)

- `--headless` does not exist. Every child is a TUI in tmux.
- Repo typecheck is dirty for a pre-existing reason: `@earendil-works/*` types don't resolve from
  the agent dir (same missing package as V12). `dd-pup-pi` contributes most of the errors.
- Untested against a real provider: the `blocked` state (V11 needs an extension that prompts), and
  the F4 `load-buffer` fallback for a genuinely beaconless child.

## Decisions (settled 2026-09-21)

- **A.** Children outlive the parent. `sub orphans` / `sub orphans --kill` / `/sub orphans` handle the
  strays, keyed on the `parent` session id + the `parent-alive` lease.
- **B.** Idle TTL 30 min (`PI_SUB_IDLE_TTL`). `closed` run dirs are removed by `sub clean` only.
- **C.** The `pi-sub` tmux server gets its own prefix (not `C-b`, so detaching inside cmux is
  unambiguous) and `status-left` showing the child name, so you always know which child you're in.
- **D.** `/sub open <name>` Tab-completes this session's children; bare `/sub open` opens a picker.
- **E.** `wait` keeps its name and means "wait until the parent's turn N has settled" (see
  "What `idle` means exactly").
