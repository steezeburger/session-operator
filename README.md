# session deck

One calm page for all the Claude Code sessions running on this Mac. It shows what each
session is doing, and when one needs a permission you can approve or deny it here.

## Run it

```sh
pnpm install
pnpm dev        # server on 127.0.0.1:4477, UI on http://127.0.0.1:5178
```

Or build once and serve everything from the server:

```sh
pnpm build && pnpm start   # http://127.0.0.1:4477
```

Env vars:

- `DECK_PORT` - server port (default 4477)
- `DECK_NOTIFY=0` - turn off macOS notifications
- `DECK_URL` / `DECK_TIMEOUT_MS` - read by `bin/deck-hook` (defaults `http://127.0.0.1:4477`, `120000`)

## How it works

```
Claude Code ──hook stdin──▶ bin/deck-hook ──POST /api/hook──▶ server (127.0.0.1)
                                  ▲                               │  in-memory pending queue
                                  └──── long-poll /wait ◀─────────┤  + transcript scan
                                                                  ▼
                                               React UI (SSE /api/events + /api/state)
```

- **Sessions** come from `~/.claude/projects/*/*.jsonl` modified in the last 24h. Only the
  tail of each file is read, and only a few fields are kept: cwd, git branch, AI title,
  last prompt (clipped to 160 chars), and the latest turn record. Nothing in a transcript
  is ever executed.
- **Status** comes from the latest turn record, then hook events override it when they
  are newer:
  - waiting - a permission request is pending, or a `Notification` hook fired
  - working - mid-turn with activity in the last 10 min
  - done - the turn ended ("your move"), within the last hour
  - idle - anything quieter than that (collapsed at the bottom)
- **Approvals.** On `PermissionRequest`, `deck-hook` posts the payload, the server queues
  it and fires a macOS notification, and the hook long-polls for your click. Approve or
  Deny becomes the hook's JSON decision.
- **Fail-safe.** The hook never approves on its own. If the server is down, errors, or
  nobody clicks before `DECK_TIMEOUT_MS`, the hook exits 0 with no output and Claude
  Code shows its normal permission prompt.
- **Localhost only.** The server binds 127.0.0.1, rejects other Host headers (DNS
  rebinding) and non-localhost Origins, and POSTs must be `application/json`. No auth
  past that.
- State is in memory. Restarting the server drops pending requests, and their hooks fall
  back to the terminal prompt.

API: `POST /api/hook`, `GET /api/state`, `POST /api/decisions/:id` with
`{"behavior":"allow"|"deny"}`, `GET /api/decisions/:id/wait`, `GET /api/events` (SSE).

## Hook setup

Add this to `~/.claude/settings.json`, merged into any `hooks` you already have (you
already have a `PreToolUse` Bash entry and a `SessionEnd` entry - add these alongside
them, don't replace them):

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/session-deck/bin/deck-hook", "timeout": 180 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/session-deck/bin/deck-hook", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/session-deck/bin/deck-hook", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/session-deck/bin/deck-hook", "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/session-deck/bin/deck-hook", "timeout": 5 }] }
    ]
  }
}
```

The `PermissionRequest` timeout (180s) needs to be above `DECK_TIMEOUT_MS` (120s) plus
one 30s poll, so the hook falls back on its own before Claude Code kills it. Killed
would still be safe though, Claude Code just shows the prompt.

Heads up: while the hook is waiting, the terminal prompt may not show until it gives
up. If that gets annoying, lower `DECK_TIMEOUT_MS` (e.g. `"command": "DECK_TIMEOUT_MS=45000 $HOME/code/session-deck/bin/deck-hook"`).

## Try it without installing the hook

```sh
pnpm start &
echo '{"hook_event_name":"PermissionRequest","session_id":"demo","cwd":"/tmp/demo","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | bin/deck-hook
# click Approve at http://127.0.0.1:4477 and the hook prints its decision JSON
```
