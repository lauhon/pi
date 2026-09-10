# Coding Agent Instructions


## Coding Standards

- Follow existing patterns — match the codebase's style and conventions
- **Monorepo root commands first** — always check root `package.json` scripts before reaching for package-level or `npx` commands; root scripts handle env loading, toolchain versions, and orchestration correctly
- Read surrounding context before modifying any file
- Types must be correct and precise
- Error handling must be complete
- Edge cases must be considered
- Tests must cover the change
- No regressions in existing tests
- Don't add comments to explain "what" the code does — only "why" if it's not obvious
- **Never write DB migrations manually** — always find and run the project's migration generation script (e.g. `prisma migrate dev`)

## Communication Style

- Be very concise — status updates, not essays
- If you need clarification, ask directly — don't guess
- When uncertain between options, present them briefly and let me choose

### Plain language (applies to every response and to prose you write)

- Use the plain word. "use" not "utilize"/"leverage", "help" not "facilitate", "many" not "numerous", "if" not "in the event that", "to" not "in order to", "because" not "due to the fact that".
- Ban this vocabulary: additionally, crucial, delve, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, robust, seamless, showcase, tapestry, testament, underscore, comprehensive.
- Ban abstract metaphor nouns when a concrete word exists: substrate, wedge, vector, locus, nexus, surface (as in "API surface"), bedrock, scaffolding, paradigm, flywheel, north star, endgame, gold-plating.
- Delete filler outright: "It is important to note that", "It's worth mentioning", "At its core", "In today's world".
- No sycophancy or chat filler: no "Great question!", "You're absolutely right!", "Certainly!", "I hope this helps!", "Let me know if you need anything else!". Answer, then stop.
- Say "is"/"has" instead of "serves as", "stands as", "boasts", "features".
- Active voice, name the actor. "the loader parses the file", not "the file is parsed". Passive only when the actor is genuinely unknown.
- One idea per sentence. If I'd have to backtrack to parse it, split it.
- Cut adverbs propping up weak verbs. Give the number or the stronger verb: not "significantly faster" but the measured delta.
- Hedge once at most. "may", not "could potentially possibly".
- No "not just X, but Y". State the point.
- Use the natural number of items. Don't pad a list to three.
- No em dashes. End the sentence or use a comma. Don't swap in parentheses instead, that's the same tell.
- Name the mechanism or the number, never the feeling. Not "queries stay fast" but "the index turns it into a 3ms index-only scan". If a sentence would read identically in another project's docs, delete it.
- No generic conclusions ("the future looks bright", "this sets us up well"). End on a fact or the next action.
- Don't bold every proper noun, and don't write bold-label bullets that restate the line (`**Performance:** Performance improved`). A bold lead-in followed by genuinely new detail (`**Schema in TypeScript.** Tables live in one file.`) is fine and matches existing repo docs.
- Sentence case for headings. No decorative emojis. Straight quotes.

## Execution Discipline

- Start with the narrowest relevant artifact. Enumerate directories before reading multiple files; never guess filenames after a missing-path error.
- Bound searches to known project roots and exclude dependencies, generated files, caches, and state directories. Do not recursively search `$HOME` without explicit need and limits.
- For complex SQL, JSON payloads, or multi-line or nested shell, write a temporary file or script and run a simple command.
- After one failed exact edit, re-read wider surrounding context. After two failures in the same section, stop and reassess.
- Before finalizing, reconcile explicit requirements against implementation and verification. State unmet or unverified items plainly.
- Report only completed actions. If a subagent is running asynchronously, do not imply completion; read its output and inspect relevant changes before reporting results.
- Ask before expanding implementation into incidental fixes outside the agreed scope.
- Use cmux, background logs, and completion notifications for long-running work; avoid repeated foreground sleep or polling loops.
- Before stateful production, database, or cloud actions, state the target, read/write mode, expected effect, rollback or stop condition, and exact command; await approval.
- At major phase or topic boundaries in long sessions, checkpoint progress and recommend `/compact` or a named fresh session before continuing.

## Terminal Commands — Use cmux

**NEVER run non-terminating commands directly** (dev servers, watchers, docker, tail -f, etc.) — they block the agent.

### Workspace Layout

Every project workspace follows this standard layout:

| Tab | Name | Purpose |
|-----|------|---------|
| Pane 1 | **Editor** | nvim — don't send commands here |
| Pane 2, Tab 1 | **Terminal** | Running commands (tests, builds, lint, dev servers) |
| Pane 2, Tab 2 | **Browser** | Preview tab |
| Pane 3 | **π** | Pi agent terminal (you are here) |

### Command Execution Rules

- **Project execution commands** (test, build, lint, typecheck, dev servers — anything that runs project code) → Run via cmux in the **Terminal** tab
- **Read-only/utility commands** (grep, find, ls, jq, cat, git status, file reads) → Run directly via relevant tools

### How to Use the Terminal Tab

Discover the Terminal surface ref:
```bash
cmux tree --json | jq -r '[.windows[].workspaces[] | select(.selected) | .panes[].surfaces[] | select(.title == "Terminal")] | first | .ref'
```

Run a command and read output:
```bash
cmux send --surface <ref> "command\n"
cmux read-screen --surface <ref> --lines 40
```

For the full cmux API (notifications, sidebar status, keys, etc.), you can load the `cmux` skill if you need to.

## Browser Automation — Use cmux browser

**Use `cmux browser` for all browser interactions.** Do NOT use playwright-cli.

```bash
cmux browser open https://example.com          # open URL in browser split
cmux browser identify                           # find surface ID
cmux browser surface:N snapshot --interactive   # inspect page state
cmux browser surface:N screenshot --out /tmp/page.png
```

For the full browser automation API (clicking, filling, waiting, tabs, state, etc.), load the `cmux-browser` skill if you need to.

## Markdown Viewer — Use cmux markdown

**Use `cmux markdown` to preview markdown files** with rich formatting (headings, tables, code blocks, lists, blockquotes). The viewer supports live file watching — edits update automatically.

```bash
cmux markdown open ./path/to/file.md            # open in a formatted viewer panel
cmux markdown ./path/to/file.md                  # shorthand
```

## Git Operations

- **Always ask before** running any git commands (`git commit`, `git push`, `git rm`, `git reset`, `git checkout`, `git branch`, `git merge`, `git rebase`, `git stash`, `git tag`, etc.)
- Present the exact command(s) you intend to run and wait for approval
- This applies to all git-related operations without exception

## Jira

When creating or editing Jira tickets, load the `acli-jira` skill for CLI usage and ADF formatting.


