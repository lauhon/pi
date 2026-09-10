---
name: acli-jira
description: Create, edit, and view Jira tickets using the acli CLI. Use when managing Jira work items.
user-invocable: true
---

# acli — Jira CLI

## View tickets

```bash
acli jira workitem view DPSCEP-123
```

## Create tickets

Use `--from-json` with ADF (Atlassian Document Format) for descriptions:

```bash
acli jira workitem create --from-json /tmp/ticket.json
```

```json
{
  "summary": "Ticket title",
  "projectKey": "DPSCEP",
  "type": "Task",
  "parentIssueId": "DPSCEP-531",
  "labels": ["my-label"],
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
