# GPT-5.6 Pi Session Audit

Date: 2026-08-12

## Rollout status

Applied on 2026-08-12:

- Terra/medium global defaults;
- cache-miss notices;
- explicit compaction configuration targeting roughly 250k context;
- global execution-discipline rules;
- stricter subagent completion/review lifecycle;
- improved long-running cmux job guidance.

Still intentionally pending:

- observe the compaction threshold in a real long session before further tuning;
- build dedicated PR-review or production-ops skills only if repeated friction remains;
- re-run the audit after 20–30 new sessions.

## Scope and method

- Analyzed 40 sessions containing GPT-5.6 responses: 15 interactive sessions and 25 sub-runs.
- Excluded the current audit session from the main metrics.
- Parsed structured JSONL model, usage, tool-call, tool-error, and stop-reason fields locally.
- Deep-reviewed every session in eight independent batches, then consolidated recurring findings.
- Private code, data, credentials, and internal identifiers are intentionally omitted from this report.

Limitations: outcomes were inferred from visible conversation, user corrections, verification reports, and error records. Hidden reasoning and most successful tool output were not used in qualitative review.

## Executive summary

GPT-5.6 is producing strong architecture, investigation, review, and production-safety work. The main problems are not raw capability; they are **workflow control, context growth, model overuse, and avoidable tool churn**.

Highest-impact changes:

1. Make **Terra + medium thinking** the default; reserve Sol/high for architecture, security, production planning, and final adjudication.
2. Add an explicit context policy: compact or start a fresh session at major phase/topic boundaries and before contexts become very large.
3. Add a small execution-discipline section to `AGENTS.md`: discover paths before reading, bound searches, use temp files for complex shell/SQL/JSON, reconcile requirements before declaring completion, and report subagent work only after reading its output.
4. Add focused skills for production operations, PR review tracking, and long-running cmux jobs instead of growing global instructions indefinitely.

## Quantitative findings

Snapshot values changed slightly while one historical session was still being written; rounded values are used where appropriate.

- About **2,000 GPT-5.6 assistant turns**.
- Recorded model cost: about **$149**.
- Cost concentration:
  - most expensive session: **47.9%** of total cost;
  - five most expensive sessions: **81.1%** of total cost.
- Model mix:

| Model | Turns | Recorded cost | Share of turns | Share of cost |
|---|---:|---:|---:|---:|
| Luna | 224 | $0.32 | 10.9% | 0.2% |
| Terra | 664 | $15.85 | 32.4% | 10.6% |
| Sol | 1,159 | $133.21 | 56.6% | 89.2% |

- Roughly **200 GPT-5.6 tool errors**:
  - 79 `read` errors;
  - 76 `bash` errors;
  - 40 `edit` errors;
  - 73 were missing-path errors;
  - 70 were failed commands;
  - 55 immediately repeated an identical tool call.
- Only **2 compactions** appeared across the 40 sessions.
- Observed request contexts reached about **314k tokens**.
- 52 visible responses exceeded 2,000 characters; 11 exceeded 5,000 characters.

Interpretation:

- Sol is valuable but currently overused as the default. Terra handled most implementation and investigation work well at a small fraction of Sol's cost.
- A few very long sessions dominate spend and reliability risk.
- Missing-path and exact-edit failures are recurring, preventable workflow errors rather than hard technical failures.

## What works well and should remain

### Investigation and planning

- Sol was consistently strong at architecture tradeoffs, security/auth reasoning, PR review, and production migration planning.
- Agents often asked good clarification questions before high-impact implementation.
- Evidence-backed explanations of database behavior, identity semantics, and infrastructure choices were useful and understandable.

### Safety

- Production-write boundaries were usually respected when explicit.
- Agents stopped on secret exposure, ambiguous destructive operations, unavailable tunnels, and unsafe data replacement plans.
- Independent review passes repeatedly caught important migration, locking, identity, and performance risks.

### Delegation

- Luna was effective for narrow mechanical edits and recon.
- Terra was effective as a sole writer for bounded multi-file implementation.
- Parent review of delegated work caught meaningful defects and should remain mandatory.

### Verification and communication

- cmux usage was common and generally successful for project execution.
- Final summaries often clearly separated changed files, validation performed, and blockers.
- Agents usually recovered well from tool and environment failures.

## Recurring problems

### 1. Sessions grow too large

The worst sessions combined planning, implementation, review, operations, follow-up fixes, and unrelated topic changes. One session reached 416 GPT-5.6 turns and cost over $71.

Consequences:

- repeated reads and verification;
- stale assumptions and state confusion;
- expensive cache writes/reads;
- harder recovery and handoff;
- increased provider/API failure exposure.

Current `settings.json` contains `"autoCompact": false`, but current Pi documentation uses `compaction.enabled`. GPT-5.6 models advertise a 1.05M-token context window, so default auto-compaction would trigger very late even when enabled.

Recommendation:

- manually `/compact` at major phase boundaries and around 100k–150k context;
- start a named fresh session when the task changes phase substantially;
- consider a context-guard extension that warns near 100k and offers compaction/new-session handoff;
- configure auto-compaction before the 272k higher-price tier, if using a large `reserveTokens` threshold is acceptable.

### 2. Sol/high is the default for routine work

Sol accounted for 89% of recorded cost but 57% of turns. Many monitoring, file-discovery, mechanical implementation, and straightforward diagnostic turns did not need Sol/high.

Recommendation:

- default to Terra/medium;
- use Luna for narrow recon/simple edits;
- explicitly switch to Sol/high for ambiguous architecture, security, production planning, and final review.

### 3. Paths are guessed instead of discovered

Repeated ADR/doc filename guesses and attempts to `read` directories caused most missing-file errors.

Recommendation:

- enumerate directories before reading multiple files;
- after one `ENOENT`, discover the actual path instead of guessing another name;
- start from changed files or the narrowest relevant artifact.

### 4. Searches and reads are broader than needed

Several sessions recursively searched large repo parents or `$HOME`, read very large files wholesale, or fetched broad external catalogs. This caused timeouts and context bloat.

Recommendation:

- scope searches to known project directories;
- exclude dependency, generated, cache, and state directories by default;
- use targeted grep plus surrounding slices before full-file reads;
- never recursively search `$HOME` without explicit need and bounds.

### 5. Complex inline shell commands are brittle

Nested cmux commands, SQL, GraphQL, JSON, loops, and heredocs caused repeated quoting failures.

Recommendation:

- write complex SQL, JSON payloads, and multi-line shell to temporary files;
- execute a short, simple command afterward;
- use absolute executable and working-directory paths.

### 6. Exact edits are retried blindly

Forty `edit` errors were observed, often from stale or non-unique `oldText`. Some agents attempted variants repeatedly or rewrote whole files.

Recommendation:

- after one failed edit, re-read wider surrounding context;
- after two failures in the same section, stop and reassess;
- keep replacement anchors minimal but unique;
- avoid whole-file rewrites unless intentionally replacing a small file.

### 7. Completion and subagent status are sometimes overstated

In one recurring failure, the agent spawned an implementation subagent, did not wait/read its output, and still implied completion. The user corrected this twice.

Recommendation:

- if a subagent is asynchronous, say only that it is running;
- do not report its outcome until its output has been read and relevant changes inspected;
- status updates must describe completed actions, not intentions.

### 8. Explicit requirements are not always reconciled before finalization

High-risk migration and cross-repo implementation tasks missed numbered requirements, semantic invariants, or expected tests until independent review.

Recommendation:

- before final response, map explicit requirements to implementation and verification evidence;
- list unmet or unverified items plainly;
- do not claim broad completion when tests were forbidden or blocked.

### 9. Scope expands without a checkpoint

PR follow-up and implementation sessions often absorbed adjacent test, docs, seed, migration, or cleanup work. The changes were sometimes valid, but the user was surprised by their extent.

Recommendation:

- separate core fix, required tests, docs, and incidental defects;
- ask before implementing incidental work outside the agreed scope.

### 10. Long-running work is polled too aggressively

Repeated `sleep`, screen reads, and subagent polling added turns and cost. Long exports/imports were sometimes run directly with large timeouts.

Recommendation:

- run long jobs in cmux/background processes with concise logs and completion notification;
- avoid foreground sleeps longer than a short confirmation window;
- use quiet progress output rather than verbose command streams.

## Unknown-error finding

Three GPT-5.6 Sol requests today ended with:

- `stopReason: error`
- `rawStopReason: failed`
- `Unknown error (no error details in response)`
- zero token usage

Two were in another session and one occurred during this audit. The immediately preceding successful requests had context-like usage of roughly 76k, 90k, and 168k tokens. Another Sol sub-run ended with `OpenAI Responses stream ended before a terminal response event`.

This proves an upstream GitHub Copilot/OpenAI Responses failure, not a shell/tool failure. Larger context may contribute, but the evidence does **not** prove causation; one failure occurred around 76k.

Mitigations:

1. Keep sessions and tool outputs smaller.
2. Compact or create a fresh handoff session at phase/topic boundaries.
3. Retry once; if repeated, switch model or fresh session instead of continuing a retry loop.
4. Preserve the session entry/response ID for a provider or Pi bug report.
5. Consider a small extension that surfaces provider-error diagnostics and warns on large context.

## Recommended `AGENTS.md` changes

Add one compact section rather than copying every project-specific lesson globally:

```markdown
## Execution Discipline

- Start with the narrowest relevant artifact. Enumerate directories before reading multiple files; never guess filenames after a missing-path error.
- Bound searches to known project roots and exclude dependencies, generated files, caches, and state directories. Do not recursively search `$HOME` without explicit need and limits.
- For complex SQL, JSON payloads, or multi-line/nested shell, write a temporary file or script and run a simple command.
- After one failed exact edit, re-read wider surrounding context. After two failures in the same section, stop and reassess.
- Before finalizing, reconcile explicit requirements against implementation and verification. State unmet or unverified items plainly.
- Report only completed actions. If a subagent is running asynchronously, do not imply completion; read its output and inspect relevant changes before reporting results.
- Ask before expanding implementation into incidental fixes outside the agreed scope.
- Use cmux/background logs and completion notifications for long-running work; avoid repeated foreground sleep/poll loops.
- Before stateful production, database, or cloud actions, state the target, read/write mode, expected effect, rollback/stop condition, and exact command; await approval.
```

Do **not** put project-specific identity semantics, migration rules, Terraform module details, or individual repository commands in global `AGENTS.md`; keep those in project `AGENTS.md` files or focused skills.

### Optional git-policy simplification

The current policy requires approval for every git command, including read-only inspection. It is safe but creates repeated pauses and occasional violations. Consider either:

- keeping strict policy but approving a clearly listed batch of read-only commands once; or
- allowing read-only `git status/diff/log/show` while retaining approval for every mutating or remote operation.

This should be an explicit user choice, not changed silently.

## Recommended settings changes

Suggested starting point:

```json
{
  "defaultModel": "gpt-5.6-terra",
  "defaultThinkingLevel": "medium",
  "showCacheMissNotices": true,
  "compaction": {
    "enabled": true,
    "reserveTokens": 800000,
    "keepRecentTokens": 30000
  }
}
```

Notes:

- Remove the undocumented/legacy `autoCompact` key after confirming no local extension depends on it.
- With a 1.05M context window, `reserveTokens: 800000` triggers compaction around 250k, before GPT-5.6's 272k higher-price tier. The name is slightly misleading for this use; test this behavior in one session before adopting globally.
- Manual `/compact` or a fresh session around 100k–150k remains preferable for coherent phase boundaries and may reduce unknown-error exposure.
- `showCacheMissNotices` is optional; keep it only if the notices are useful rather than noisy.

## Recommended skills/workflow additions

Prioritize three focused skills:

1. **Production data/DB operations**
   - target and access-mode preflight;
   - transport-option comparison;
   - credential-safe command patterns;
   - idempotency, rollback/PITR, locking, bounded verification;
   - rehearsal, checksums, concise monitoring, cleanup.

2. **GitHub PR review tracker**
   - fetch unresolved threads with `gh`;
   - visible checklist of thread, validity, action, local/pushed/replied/resolved state;
   - structured JSON payload files instead of fragile inline GraphQL;
   - never claim all feedback handled until every item is closed.

3. **Long-running cmux job helper**
   - start in the correct Terminal surface and cwd;
   - write concise logs;
   - verify visible pane/tab creation;
   - completion/failure notification;
   - no tight polling loops.

Also update the subagent workflow to make the normal lifecycle explicit:

`spawn → continue other work or wait → read output → inspect changes → verify → report`

## Model-routing recommendation

| Work type | Default |
|---|---|
| Narrow file discovery, summaries, simple mechanical edits | Luna |
| Normal implementation, debugging, bounded research | Terra |
| Architecture, security/auth, production planning, difficult review | Sol |
| Final review of safety-critical Terra/Luna work | Sol |

The strongest model should adjudicate risk, not perform every mechanical step.

## Recommended rollout

1. Change default model/thinking to Terra/medium.
2. Add the compact `Execution Discipline` section.
3. Adopt manual compact/new-session checkpoints immediately.
4. Test the proposed compaction threshold in one long session.
5. Add the subagent and long-job workflow improvements.
6. Build PR-review and production-ops skills only after observing which repeated steps remain painful.
7. Re-run this audit after 20–30 new sessions and compare cost, errors, corrections, compactions, and unknown failures.
