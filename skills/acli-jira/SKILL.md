---
name: acli-jira
description: Create, edit, and view Jira tickets using the acli CLI. Use when managing Jira work items.
user-invocable: true
---

# acli — Jira CLI

## TEMPORARY: acli machine access is down (remove when fixed)

acli can't reach Jira right now. Read tickets through the logged-in cmux browser instead (load the `cmux-browser` skill for the full API):

```bash
cmux browser open https://redbull-gms.atlassian.net/browse/DPSCEP-123   # prints surface:N
cmux browser surface:N wait --load-state complete --timeout-ms 20000
cmux browser surface:N get title                                         # "[KEY] summary - Jira"
cmux browser surface:N get text "[data-testid='issue.views.field.rich-text.description']"
cmux browser surface:N eval "[...document.querySelectorAll('[data-testid*=\"status\"] button, [data-testid*=\"assignee\"]')].map(e=>e.innerText).join(' | ')"
```

For the next ticket, reuse the surface: `cmux browser surface:N navigate <url>`.

**Editing the description (fastest):** `scripts/jira-browser.sh` calls `/rest/api/3` with `fetch` inside the logged-in tab, so the session cookie authenticates. It finds or opens an atlassian.net browser surface (override with `JIRA_SURFACE=surface:N`).

```bash
JB=/Users/laurenz/.pi/agent/skills/acli-jira/scripts/jira-browser.sh
$JB get DPSCEP-123                      # -> /tmp/DPSCEP-123.desc.json (ADF)
# edit the ADF file (jq or write), same ADF rules as below
$JB put DPSCEP-123 /tmp/DPSCEP-123.desc.json   # prints "204 " on success
$JB json DPSCEP-123 body.json           # any {"fields":{...}} PUT, e.g. summary/labels
```

A `400 INVALID_INPUT` means the ADF is malformed; auth worked. Re-run `get` after `put` to verify.

## View tickets

```bash
acli jira workitem view DPSCEP-123
```

## Create tickets

Use `--from-json` with ADF (Atlassian Document Format) for descriptions. Every new ticket gets the label `grooming`, unless the user asks otherwise:

```bash
acli jira workitem create --from-json /tmp/ticket.json
```

```json
{
  "summary": "Ticket title",
  "projectKey": "DPSCEP",
  "type": "Task",
  "parentIssueId": "DPSCEP-531",
  "labels": ["grooming"],
  "description": { "type": "doc", "version": 1, "content": [...] },
  "additionalAttributes": {
    "components": [{"name": "My Component"}]
  }
}
```

## Edit tickets

**Assign / labels:**
```bash
acli jira workitem edit --from-json /tmp/edit.json --yes
```
```json
{ "issues": ["DPSCEP-123"], "assignee": "user@company.com" }
{ "issues": ["DPSCEP-123"], "labelsToAdd": ["new-label"] }
```

**Description — MUST use ADF via `--from-json`:**
```bash
acli jira workitem edit --from-json /tmp/desc.json --yes
```
```json
{
  "issues": ["DPSCEP-123"],
  "description": {
    "type": "doc",
    "version": 1,
    "content": [
      {
        "type": "heading",
        "attrs": {"level": 2},
        "content": [{"type": "text", "text": "Section Title"}]
      },
      {
        "type": "paragraph",
        "content": [{"type": "text", "text": "Body text. "}, {"type": "text", "text": "Bold text", "marks": [{"type": "strong"}]}]
      },
      {
        "type": "bulletList",
        "content": [
          {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Item 1"}]}]}
        ]
      },
      {
        "type": "orderedList",
        "attrs": {"order": 1},
        "content": [
          {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Step 1"}]}]}
        ]
      },
      {
        "type": "codeBlock",
        "attrs": {"language": "json"},
        "content": [{"type": "text", "text": "{ \"key\": \"value\" }"}]
      }
    ]
  }
}
```

**CRITICAL:** Never use `--description` flag with plain text or wiki markup — it renders literally (h2. shows as text). Always use `--from-json` with ADF for descriptions.

## Common gotchas

- `components` can only be set on create (via `additionalAttributes`), not on edit
- `--description` flag does NOT support wiki markup — use `--from-json` with ADF
- Labels on edit use `labelsToAdd` / `labelsToRemove`, not `labels`
