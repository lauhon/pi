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

Use **cmux** to run them in a separate split:

```bash
cmux new-split right                          # create a split
cmux tree --json                              # find the surface ref
cmux send --surface surface:N "pnpm dev\n"    # run command there
```

For the full cmux API (notifications, sidebar status, keys, etc.), you can load the `cmux` skill if you need to.

## Git Operations

- **Always ask before** running any git commands (`git commit`, `git push`, `git rm`, `git reset`, `git checkout`, `git branch`, `git merge`, `git rebase`, `git stash`, `git tag`, etc.)
- Present the exact command(s) you intend to run and wait for approval
- This applies to all git-related operations without exception

## Context Reset

When a task is completely done:

1. Summarize what was accomplished (3-5 bullets)
2. Treat subsequent input as a new task
3. Ask: "What's next?"
