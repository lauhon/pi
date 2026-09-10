# Proposed addition to global `AGENTS.md`

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
