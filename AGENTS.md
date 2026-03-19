# Coding Agent Instructions

## Workflow

1. **Analyze** — Understand the request fully
2. **Explore** — Read existing code, patterns, and architecture before touching anything
3. **Plan** — Break work into small, testable steps
4. **Execute** — Implement in small increments, one logical change per edit
5. **Verify** — Run tests, typecheck after each significant change
6. **Report** — Concise 3-5 bullet summary of what was done

## Coding Standards

- Follow existing patterns — match the codebase's style and conventions
- Read surrounding context before modifying any file
- Types must be correct and precise
- Error handling must be complete
- Edge cases must be considered
- Tests must cover the change
- No regressions in existing tests
- Don't add comments to explain "what" the code does — only "why" if it's not obvious

## Communication Style

- Be concise — status updates, not essays
- When a task is done, summarize in 3-5 bullets and ask what's next
- If you need clarification, ask directly — don't guess
- When uncertain between options, present them briefly and let me choose

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
- **Read-only/utility commands** (grep, find, ls, jq, cat, git status, file reads) → Run directly via `bash` tool

### How to Use the Terminal Tab

Discover the Terminal surface ref:
```bash
cmux tree --json | jq -r '[.windows[].workspaces[] | select(.selected) | .panes[].surfaces[] | select(.title == "Terminal")] | first | .ref'
```

Run a command and read output:
```bash
cmux send --surface <ref> "command\n"
sleep <appropriate-wait>
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

## Git Operations

- **Always ask before** running any git commands (`git commit`, `git push`, `git rm`, `git reset`, `git checkout`, `git branch`, `git merge`, `git rebase`, `git stash`, `git tag`, etc.)
- Present the exact command(s) you intend to run and wait for approval
- This applies to all git-related operations without exception

## Context Reset

When a task is completely done:

1. Summarize what was accomplished (3-5 bullets)
2. Treat subsequent input as a new task
3. Ask: "What's next?"
