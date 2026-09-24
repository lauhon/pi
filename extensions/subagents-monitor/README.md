# subagents-monitor

> Last reviewed: 2026-09-22 · Owner: @laurenz

Read-only observer of subagent children, plus the `/sub` command. It renders the
widget you see at the top of the session and decides when the parent agent hears
about a child.

It never changes a child itself. Every mutation shells out to
[`skills/subagents/sub`](../../skills/subagents/sub), so the CLI and the widget
can't disagree about what a child is doing.

- The design and its reasoning: [spec-interactive-children.md](../../skills/subagents/spec-interactive-children.md)
- How to *use* children (spawn, resume, review): [skills/subagents/SKILL.md](../../skills/subagents/SKILL.md)

## The one thing to understand: a child is not a process that finishes

A child is a full pi TUI running in a detached tmux session. It does a turn,
then **sits there idle, waiting for the next one**, keeping its whole context.
It is not a command that runs to completion and dies.

So "idle" and "killed" are completely different things:

| | idle | closed / dead |
| --- | --- | --- |
| Is it running? | yes, a live pi process | no, tmux session gone |
| Context | intact, in memory | on disk in `session.jsonl` |
| Costs tokens? | no, it's waiting | no |
| `sub resume` | continues instantly | respawns first (one pi startup), then continues |
| You can attach? | yes, and type | yes — `open` respawns it |

Idle is the normal resting state. A child that finished its task is idle, not
gone. It stays that way until you resume it, you kill it, or it hits its idle
TTL (default 30 min — `DEFAULT_IDLE_TTL_MS` in
[beacon/index.ts](../../skills/subagents/beacon/index.ts)), which closes it
cleanly. Nothing is lost when that happens: the session file survives and
`resume`/`open` bring it back.

The TTL won't fire while you're attached to the child or while it still has
undrained work.

## Left column symbols

Each row is `<attach><state> <name> <elapsed> turn <n> <detail> … <tokens> <cost> <provider/model>`.

The first character is the attach indicator, the second is the state.

| | Meaning |
| --- | --- |
| `◉` | **someone is attached** to this child right now (you, in another tab) |
| (blank) | nobody attached |

| | State | What it means | What to do |
| --- | --- | --- | --- |
| `⋯` | `starting` | tmux session up, pi still booting | wait a few seconds |
| `●` | `running` | mid-turn — yours or a human's | `sub open` to watch, `sub stop` to abort the turn |
| `◇` | `idle` | settled, inbox empty, waiting | `sub resume`, or leave it |
| `⚑` | `blocked` | an extension is asking a question — **needs a human** | `sub open` and answer it |
| `⚠` | `beaconless` | tmux alive but the beacon never loaded | `sub open` and drive it by hand |
| `✔` | `closed` | clean exit (kill, `/quit`, idle TTL) | `resume`/`open` respawns it |
| `✘` | `dead` | tmux gone without a clean exit (crash, `--force`) | same as closed; `sub` just won't call it clean |

`closed` and `dead` differ only in how the child left. Both are respawnable and
keep their history.

Finished children linger in the widget for a minute so you see them go, then
disappear. Ones that were already finished when the session started never show
up — pi keeps the same session id across a restart, so otherwise every child
you'd ever spawned would reappear.

## The detail column

Mostly the child's last activity, with four cases worth recognising:

- **`waiting on provider, 2m`** — the child asked the model and is waiting for a
  reply. Normal. Large-context calls routinely take 1–3 minutes. Never notifies.
- **`⚠ stuck: bash (4m)`** — a *tool call* has been open far too long (an
  unbounded `find /`, a hung command). Worth looking at. Notifies once, naming
  the tool.
- **`⚑ needs you`** — blocked on a prompt; it will sit forever until a human answers.
- **`⚠ beaconless (no state.json)`** — the child is alive but unobservable, usually
  a bad `-e` path. `resume` falls back to pasting keys; `wait` refuses rather than hanging.

The distinction between the first two is the point: a slow model call and a
stuck tool look identical from the outside if you only watch file mtimes.

## When the parent gets told

Keyed on **who prompted the turn**, recorded in the child's `turns.jsonl`:

- **You (the parent agent) prompted it** → the parent gets a completion notice
  and continues on its own.
- **A human typed into the child** → the parent stays quiet, waits ~10 s for you
  to stop typing, then gets *one* note with what you said. Steering a child
  never interrupts the parent mid-thought.
- **Origin unknown** → silence.

Thresholds live in `DEFAULT_CONFIG` in [index.ts](./index.ts).

## `/sub`

`open [name]` · `list` · `stop <name>` · `kill <name>` · `orphans` · `clean`

Tab completes verbs and this session's child names. `/sub open` with no name
opens a picker. `open` puts the child in a new cmux tab; you can type in it and
leave whenever you like.

The tab is a tmux pane, so the scroll wheel scrolls tmux's history rather than
the terminal's. It enters tmux copy-mode; `q` or Escape leaves it. The mouse
setting and the history length live in
[skills/subagents/tmux.conf](../../skills/subagents/tmux.conf), which only
applies to the `pi-sub` server. The same file turns on tmux extended keys, so
Shift+Enter adds a new line instead of submitting. A child started before a
change to that file keeps its old history length and key handling until it
restarts: `/sub kill <name>`, then `/sub open <name>`.

`stop` aborts the current turn but keeps the child alive. `kill` ends the child:
it aborts, waits for idle so it never kills work mid-flight, asks pi to quit,
and only then force-kills the tmux session. `orphans` finds children whose
parent session is gone — they keep running by design.

## Layout warning

Tests live in `index.test.ts` **inside this folder**, never as
`extensions/*.test.ts`. pi auto-discovers `extensions/*.ts` and loads it as an
extension; a test file there imports vitest outside a test run, throws, and
takes down every extension in the session. There's a test that enforces this.
