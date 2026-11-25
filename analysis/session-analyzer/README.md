## Links

Every view of the attention page (`http://127.0.0.1:4317`) has a URL. The panel's "Copy link" button copies it.

| Route | Opens |
| --- | --- |
| `/` | glance, no panel |
| `/decision/<catchKey>` | that catch; key is `<sessionId>:<entryId>`, URL-encoded |
| `/memory?state=relevant\|stale\|open\|done&q=&repo=&session=<ref>` | memory panel with those filters |
| `/memory/<itemId>` | memory panel with that item expanded (falls back to done) |
| `/session/<ref>?request=<n>` | context panel; `n` is 1-based as shown on the page |

Resolve with read-only GETs (no token needed, Host must be `127.0.0.1:4317`):

- decision: `curl -s 'http://127.0.0.1:4317/api/attention?hours=336'`, then find `catches[]` with `key` equal to the decoded key. It has `decision`, `basis`, `requestIndex`, `sessionRef`.
- memory item: `curl -s 'http://127.0.0.1:4317/api/memory/items?state=open&query=<id>'`; if empty, repeat with `state=done`. Filter links take the same `state`, `query` (`q`), `repo`.
- session: `curl -s 'http://127.0.0.1:4317/api/session?ref=<ref>'` (one point per request).
- request: `curl -s 'http://127.0.0.1:4317/api/request?ref=<ref>&i=<n-1>'`, since `i` is 0-based.

An empty result or a 404 means the item is gone or outside the served directories.
