---
name: clockify
description: Book time in Clockify and reconstruct what to book from today's pi sessions. Use when the user asks to summarize the day's work for time tracking, suggest hours per Jira ticket, or create, list or delete Clockify time entries.
---

# Clockify time booking

Two stdlib-only Python scripts, no third-party install:

- `scripts/pi-sessions.py [YYYY-MM-DD]` lists the pi sessions active that day: local time span, Jira keys (`--ticket-prefix`, default `DPSCEP`), branches and the user prompts.
- `scripts/clockify.py` calls the official Clockify REST API.

## Auth

The script reads the API key from `CLOCKIFY_API_KEY` or the macOS Keychain item `clockify-api-key`. Never ask the user to paste the key into chat. If it's missing, tell them to run this in their own terminal (it prompts for the key):

```bash
security add-generic-password -a "$USER" -s clockify-api-key -w
```

They create the key in Clockify under Profile settings, API section. Optional env: `CLOCKIFY_WORKSPACE_ID` (default: the user's active workspace), `CLOCKIFY_API_URL` (default `https://api.clockify.me/api`; regional or subdomain workspaces need their own URL and key).

## Laurenz's conventions (from past entries)

- Project `DevRell '26` (`695b75b804e3736681ed7a8b`, client RedBull), no task, no tags, `billable: true`.
- Description: `DPSCEP-1234 - short description`. Non-ticket work gets a plain description (meetings, support).
- Days start at 08:00, blocks in 15 or 30 minute steps.
- Check `clockify.py entries --date <day>` first, the user may have booked parts by hand.

## Workflow

1. Run `pi-sessions.py <day>`. Group the sessions by ticket. Parallel sessions overlap, so the total must not exceed the clock span from first to last activity. Say that meetings and work outside pi are not covered.
2. Present a table: time, what was done, ticket, hours. Then a per-ticket list with a 3 to 10 word description. Get the user's OK on hours and ticket mapping.
3. Find the project and task: `clockify.py projects [--name X]`, `clockify.py tasks <project>`. Ask the user which project and task to use, and whether entries are billable, unless a previous plan answers it.
4. Write a plan file to `/tmp/clockify-<day>.json`. Lay entries back to back from the day's start, longest ticket blocks in the order they happened, no overlaps:

   ```json
   {
     "defaults": { "project": "Project name or id", "task": "optional task", "billable": false },
     "entries": [
       { "start": "2026-11-16 08:45", "end": "2026-11-16 12:15", "description": "DPSCEP-2221 Imported score enrichment fixes and deploy" }
     ]
   }
   ```

   Times are local. Each entry may override `project`, `task`, `billable`. Put the ticket key first in the description.
5. `clockify.py book /tmp/clockify-<day>.json` is a dry run. Show the output. Only after the user approves, run it with `--apply`. Entries that already exist (same start and description) are skipped, so a re-run is safe.
6. Check with `clockify.py entries --date <day>`. To undo, `clockify.py delete <entryId>...` with the ids that `book --apply` printed.

The workspace is on the free plan: 30 API requests per hour. `book` costs 2 requests plus 1 per entry, so avoid extra `entries`/`projects` calls before booking. On a 429, re-run after an hour; existing entries are skipped.

Writing to Clockify is a stateful action: always dry run first and wait for approval.
