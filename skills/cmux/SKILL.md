---
name: cmux
description: Use cmux CLI to run long-lived processes, manage terminal splits, send commands, and show status in the sidebar. Use when running dev servers, build watchers, or any non-terminating command.
user-invocable: true
---

# cmux — Terminal Multiplexer CLI

cmux is the terminal multiplexer for Ghostty. Use it instead of tmux for managing long-running processes, splits, and terminal interaction.

Full docs: https://cmux.com/de/docs/api (note: some commands differ from docs — this skill reflects the actual CLI)

## Core Pattern: Long-Running Commands

```bash
# 1. Create a split
cmux new-split right          # or: down, left, up

# 2. Find the new surface ref
cmux tree --json              # shows full layout with surface refs (surface:N)

# 3. Send command to that surface
cmux send --surface surface:4 "npm run dev\n"

# 4. Read output from a surface
cmux read-screen --surface surface:4

# 5. Send more input or keys later
cmux send --surface surface:4 "some input\n"
cmux send-key --surface surface:4 enter
```

## Important: Actual CLI vs Docs

The website docs show some commands that differ from the actual CLI:
- **`list-surfaces`** → use `tree --json` or `list-pane-surfaces`
- **`send-surface --surface <id> "text"`** → use `send --surface <ref> "text"`
- **`send-key-surface --surface <id> <key>`** → use `send-key --surface <ref> <key>`
- **`focus-surface --surface <id>`** → use `focus-pane --pane <ref>`
- **Surface refs** use format `surface:N` (e.g., `surface:4`), not raw UUIDs
- **Socket path** is `~/Library/Application Support/cmux/cmux.sock` (not `/tmp/cmux.sock`)

## Detection

```bash
# Check if inside cmux
[ -n "${CMUX_WORKSPACE_ID:-}" ] && echo "In cmux"

# Check if CLI available
command -v cmux &>/dev/null && echo "cmux available"
```

## Key Commands

### Layout & Surfaces

| Command | Description |
|---|---|
| `cmux new-split <direction>` | Create split: `right`, `down`, `left`, `up` |
| `cmux tree --json` | Full layout tree with all surface/pane refs |
| `cmux list-panes` | List panes in current workspace |
| `cmux list-pane-surfaces` | List surfaces in panes |
| `cmux focus-pane --pane <ref>` | Focus a pane |
| `cmux close-surface --surface <ref>` | Close a surface |

### Input & Output

| Command | Description |
|---|---|
| `cmux send "text\n"` | Send text to focused terminal (`\n` = enter) |
| `cmux send --surface <ref> "text\n"` | Send text to a specific surface |
| `cmux send-key <key>` | Send key to focused terminal |
| `cmux send-key --surface <ref> <key>` | Send key to specific surface |
| `cmux read-screen --surface <ref>` | Read current terminal content |
| `cmux read-screen --surface <ref> --scrollback` | Include scrollback buffer |

Keys: `enter`, `tab`, `escape`, `backspace`, `delete`, `up`, `down`, `left`, `right`

### Workspaces

| Command | Description |
|---|---|
| `cmux list-workspaces` | List all workspaces |
| `cmux current-workspace` | Get active workspace |
| `cmux select-workspace --workspace <ref>` | Switch workspace |

### Notifications

```bash
cmux notify --title "✓ Build Success" --body "Ready to deploy"
cmux notify --title "✗ Build Failed" --body "Check the logs"
```

### Sidebar Metadata

```bash
# Status pills
cmux set-status build "compiling" --icon hammer --color "#ff9500"
cmux clear-status build

# Progress bar (0.0–1.0)
cmux set-progress 0.5 --label "Building..."
cmux clear-progress

# Log entries (levels: info, progress, success, warning, error)
cmux log "Build started"
cmux log --level error --source build "Compilation failed"
cmux log --level success -- "All 42 tests passed"
```

### Utility

| Command | Description |
|---|---|
| `cmux identify --json` | Show current window/workspace/surface context |
| `cmux tree` | Human-readable layout tree |
| `cmux capabilities --json` | List available methods |

## Environment Variables

| Variable | Description |
|---|---|
| `CMUX_WORKSPACE_ID` | Auto-set: current workspace ID |
| `CMUX_SURFACE_ID` | Auto-set: current surface ID |
| `CMUX_SOCKET_PATH` | Override socket path (default: `~/Library/Application Support/cmux/cmux.sock`) |

## Socket API

For programmatic access, send JSON-RPC to the Unix socket:

```bash
SOCK="${CMUX_SOCKET_PATH:-$HOME/Library/Application Support/cmux/cmux.sock}"
printf '{"id":"1","method":"workspace.list","params":{}}\n' | nc -U "$SOCK"
```

Method naming: `workspace.list`, `surface.split`, `surface.send_text`, `surface.send_key`, `notification.create`, `system.ping`, etc.
