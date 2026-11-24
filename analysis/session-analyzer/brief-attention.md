# Brief: an attention layer for parallel agent work

Interview with Laurenz, 2026-11-24, 15 questions. Notes: `/tmp/interview/notes.md`.

## What I learned

- The current view led to zero actions today. "Most things are correct. Viewing everything makes
  everything irrelevant." The only part he uses is the live session list with cost.
- All of today's setup wins (skills hidden, hypa removed, GLS AGENTS.md cut) came from a session
  dedicated to setup work. He wants that meta layer to move out of work sessions and into the
  monitor, so work threads stay on the ticket.
- His problems are invisible until the damage shows: hidden assumptions at the wrong level, two asks
  in one prompt, ambiguous references, contradictions in loaded context, forgotten open work.
- He won't hand-label sessions and can't recall outcomes later. D7's "relabel ~20 sessions" plan
  will probably not happen.
- He already produces outcome signals: Esc + correction (most often), /tree rewind (if it saves a lot
  of context), new session (if it's really bad).
- Handover decision = days on the same session + dollar amount, by feel. Context size and
  compactions don't drive it.
- Tolerance is high: "any positive catch is worth it", patient on latency. Each catch should say what
  it saved so he can judge it.
- Data (7 days): 25 main sessions $131, 29 sub-runs $13. RedBull meta session: 345 requests, $19,
  3+ compactions, still live.

## Jobs, ranked by frequency x cost

1. Catch a wrong-level decision while the run is still cheap to steer (many times a day, cost = a
   redo). Covers agent assumptions and his own two-asks/ambiguous prompts.
2. Know which of 3 to 4 parallel sessions needs him now, including tabs he isn't looking at (constant).
3. Capture setup opportunities found during work without derailing it, and decide later whether to
   act (daily, low per item, compounds).
4. Know when to hand over a long session and make that one step (a few times a week).
5. Find out whether a rule or skill change helped, without labeling by hand (weekly).
6. Not lose important open work (work memory, low frequency, high regret).

Where he doesn't want a tool: inside the work thread. No meta commentary in the work session.

## Design from scratch

An inbox of catches, not a dashboard. The default state is empty. Each item is one line: session,
what happened, why it matters, estimated saving, and one or two actions.

### Producers (what creates items)

| Producer | Trigger | Item | Actions |
|---|---|---|---|
| `assumption` tool | Agent calls it when it decides something more concrete than the ask (design, scope, data, prod target). AGENTS.md rule says when. | "GLS: assumes reset also clears cached rankings" | Steer (type a reply sent to that session), Accept, Dismiss |
| Pre-send prompt check | On Enter, a cheap model checks the prompt for two asks or a reference with two readings | Inline in pi: "2 asks: split?" / "'the export': A or B?" | Send anyway (one key), Split, Edit |
| Watcher (cheap model, per request or per turn) | Contradiction between loaded AGENTS.md/skills/memory, a large repeated tool output, a skill loaded but never used | "AGENTS.md says X, db skill says Y" | New session on it, Save to work memory, Dismiss |
| Outcome detector (no model) | Esc + user correction, /tree rewind, session abandoned for a new one | Auto-label on the preceding turn, linked to any catch nearby | Optional one-word cause |
| Session age | Days on the session + $ over his threshold | "RedBull: 2 days, $19" | Handover (agent writes prompt, opens new cmux tab) |

### Monitor screen (spare 1080p)

- Left: active main sessions only, one row per repo/cmux tab: name, status (running / waiting for
  you / idle), age in days, $. Sub-runs nested under their parent, collapsed.
- Center: the inbox, newest first. Items from sessions not in focus get a strong highlight and an
  optional `cmux notify`. Urgent items (assumptions on a running session) stay above setup items.
- Each handled item records his verdict: useful / noise. That gives per-catch labels for free.

### Weekly review (generated, not a screen he has to fill)

One page: catches by producer with useful/noise rate, outcome-detector events per repo, rule and
skill changes this week with interrupt rate before vs after, open opportunities saved to memory,
work-memory items older than 7 days.

## Keep, change, drop in the current view

- Keep: live session list with cost (the only part he uses). Keep the analyzer as the data layer.
- Change: list = main sessions per repo, sub-runs nested, add age in days and "updated at", replace
  "live" with real status. Follow mode is replaced by the inbox.
- Drop from the glance: stacked area chart, treemap, fixed/conversation share, largest segments.
  Move them to a drill-down opened from a catch ("why is this block here").
- Drop D7's hand relabeling, use the outcome detector plus per-catch verdicts instead.

## Smallest first version (about 2 to 3 days)

1. `assumption` tool in a pi extension + an AGENTS.md rule for when to call it.
2. Outcome detector over session files (Esc+correction, /tree, abandoned) writing events.
3. Monitor page: the trimmed session list + the inbox of those two producers, with Steer (via pi durable) and
   useful/noise buttons, and highlight for sessions not in focus.

Measure after one week: number of assumption items, share marked useful, interrupts per session
before vs after. Add the pre-send check and watcher only if assumptions prove useful.

## Settled after the brief (follow-up answers)

- Wrong level = scope (mostly) and DB schema. The `assumption` rule targets only these two at first.
- False alarms: up to 1 per minute is acceptable. Start loose, tighten from the useful/noise data.
- Prompt and tool text on the spare monitor: fine.
- Steer from the view: use pi durable to send messages into a running session. Subtask: move the
  subagents extension onto it so sub-runs can be steered the same way.

## Open questions

- How to compute "saving" per catch honestly (tokens until the next interrupt?).
- pi durable: verify it exists in his setup and how sessions receive messages; the local pi docs
  only show RPC `get_entries` with a durable cursor.
- How to detect "in focus": cmux API for the active tab?
- Watcher cost and model choice: run per request or per turn? Copilot quota limits?
