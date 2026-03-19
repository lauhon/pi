---
name: cmux-browser
description: Browser automation via cmux browser commands. Use when navigating websites, interacting with web pages, filling forms, taking screenshots, inspecting DOM, or extracting information from web pages.
user-invocable: true
---

# cmux browser — Browser Automation

Full docs: https://cmux.com/docs/browser-automation

## Quick Start

```bash
# Open a URL in a browser split
cmux browser open https://example.com

# Find the surface ID for targeting
cmux browser identify

# All subsequent commands target a surface
cmux browser surface:N snapshot --interactive --compact
cmux browser surface:N screenshot --out /tmp/page.png
cmux browser surface:N click "button[type='submit']" --snapshot-after
```

## Navigation

```bash
cmux browser open https://example.com
cmux browser open-split https://example.com        # open in new split

cmux browser surface:N navigate https://example.com/page --snapshot-after
cmux browser surface:N back
cmux browser surface:N forward
cmux browser surface:N reload --snapshot-after
cmux browser surface:N url
```

## Waiting

Block until a condition is met before proceeding.

```bash
cmux browser surface:N wait --load-state complete --timeout-ms 15000
cmux browser surface:N wait --selector "#checkout" --timeout-ms 10000
cmux browser surface:N wait --text "Order confirmed"
cmux browser surface:N wait --url-contains "/dashboard"
cmux browser surface:N wait --function "window.__appReady === true"
```

## DOM Interaction

Use `--snapshot-after` on mutating actions for fast verification.

```bash
cmux browser surface:N click "button[type='submit']" --snapshot-after
cmux browser surface:N dblclick ".item-row"
cmux browser surface:N hover "#menu"
cmux browser surface:N focus "#email"
cmux browser surface:N check "#terms"
cmux browser surface:N uncheck "#newsletter"
cmux browser surface:N scroll-into-view "#pricing"

cmux browser surface:N type "#search" "query text"
cmux browser surface:N fill "#email" --text "user@example.com"
cmux browser surface:N fill "#email" --text ""                    # clear field
cmux browser surface:N press Enter
cmux browser surface:N keydown Shift
cmux browser surface:N keyup Shift
cmux browser surface:N select "#region" "us-east"
cmux browser surface:N scroll --dy 800 --snapshot-after
cmux browser surface:N scroll --selector "#log-view" --dx 0 --dy 400
```

## Inspection

```bash
# Snapshots (primary inspection tool)
cmux browser surface:N snapshot --interactive --compact
cmux browser surface:N snapshot --selector "main" --max-depth 5

# Screenshots
cmux browser surface:N screenshot --out /tmp/page.png

# Getters
cmux browser surface:N get title
cmux browser surface:N get url
cmux browser surface:N get text "h1"
cmux browser surface:N get html "main"
cmux browser surface:N get value "#email"
cmux browser surface:N get attr "a.primary" --attr href
cmux browser surface:N get count ".row"
cmux browser surface:N get box "#checkout"
cmux browser surface:N get styles "#total" --property color

# Boolean checks
cmux browser surface:N is visible "#checkout"
cmux browser surface:N is enabled "button[type='submit']"
cmux browser surface:N is checked "#terms"

# Finders
cmux browser surface:N find role button --name "Continue"
cmux browser surface:N find text "Order confirmed"
cmux browser surface:N find label "Email"
cmux browser surface:N find placeholder "Search"
cmux browser surface:N find testid "save-btn"
cmux browser surface:N find first ".row"
cmux browser surface:N find last ".row"
cmux browser surface:N find nth 2 ".row"

# Highlight element visually
cmux browser surface:N highlight "#checkout"
```

## JavaScript

```bash
cmux browser surface:N eval "document.title"
cmux browser surface:N eval --script "window.location.href"

cmux browser surface:N addinitscript "window.__ready = true;"
cmux browser surface:N addscript "document.querySelector('#name')?.focus()"
cmux browser surface:N addstyle "#debug-banner { display: none !important; }"
```

## Tabs

```bash
cmux browser surface:N tab list
cmux browser surface:N tab new https://example.com/pricing
cmux browser surface:N tab switch 1
cmux browser surface:N tab switch surface:7
cmux browser surface:N tab close
cmux browser surface:N tab close surface:7
```

## State & Session Data

```bash
# Cookies
cmux browser surface:N cookies get
cmux browser surface:N cookies get --name session_id
cmux browser surface:N cookies set session_id abc123 --domain example.com --path /
cmux browser surface:N cookies clear --name session_id
cmux browser surface:N cookies clear --all

# Local storage
cmux browser surface:N storage local set theme dark
cmux browser surface:N storage local get theme
cmux browser surface:N storage local clear

# Session storage
cmux browser surface:N storage session set flow onboarding
cmux browser surface:N storage session get flow

# Full state save/restore
cmux browser surface:N state save /tmp/browser-state.json
cmux browser surface:N state load /tmp/browser-state.json
```

## Console & Errors

```bash
cmux browser surface:N console list
cmux browser surface:N console clear
cmux browser surface:N errors list
cmux browser surface:N errors clear
```

## Dialogs & Frames & Downloads

```bash
# Dialogs
cmux browser surface:N dialog accept
cmux browser surface:N dialog accept "Confirmed"
cmux browser surface:N dialog dismiss

# Frames
cmux browser surface:N frame "iframe[name='checkout']"
cmux browser surface:N frame main                          # back to top-level

# Downloads
cmux browser surface:N download --path /tmp/report.csv --timeout-ms 30000
```

## Common Patterns

### Open, wait, inspect

```bash
cmux browser open https://example.com
cmux browser identify                                       # note the surface:N
cmux browser surface:N wait --load-state complete --timeout-ms 15000
cmux browser surface:N snapshot --interactive --compact
```

### Fill form and verify

```bash
cmux browser surface:N fill "#email" --text "user@example.com"
cmux browser surface:N fill "#password" --text "secret"
cmux browser surface:N click "button[type='submit']" --snapshot-after
cmux browser surface:N wait --text "Welcome"
```

### Debug on failure

```bash
cmux browser surface:N console list
cmux browser surface:N errors list
cmux browser surface:N screenshot --out /tmp/failure.png
cmux browser surface:N snapshot --interactive --compact
```
