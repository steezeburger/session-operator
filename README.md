# session operator

One calm page for all the Claude Code sessions running on this Mac. It shows what each
session is doing, and when one needs a permission you can approve or deny it here.

![Session operator with sessions that need approval, need a reply, are failing, waiting on CI, working, idle and closed](docs/screenshot.png)

<sub>Demo data. The sessions, cards and PRs in the screenshot are made up.</sub>

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

- `OPERATOR_PORT` - server port (default 4477)
- `OPERATOR_NOTIFY=0` - turn off macOS notifications
- `OPERATOR_URL` / `OPERATOR_TIMEOUT_MS` - read by `bin/operator-hook` (defaults `http://127.0.0.1:4477`, `120000`)

## How it works

```
Claude Code ──hook stdin──▶ bin/operator-hook ──POST /api/hook──▶ server (127.0.0.1)
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
  are newer. Colors: orange = needs you, red = failing, green = working, gray = idle.
  - waiting (orange) - a permission request is pending, or a `Notification` hook fired
  - done (orange, "your move") - the turn ended within the last hour
  - failing (red) - stuck mid-turn for 10+ min, the last tool result was an error, or the
    latest record is an API error
  - working (green) - mid-turn with recent activity
  - idle (gray) - anything quieter, including sessions stopped mid-turn over an hour ago
- **Approvals.** On `PermissionRequest`, `operator-hook` posts the payload, the server queues
  it and fires a macOS notification, and the hook long-polls for your click. Approve or
  Deny becomes the hook's JSON decision.
- **Fail-safe.** The hook never approves on its own. If the server is down, errors, or
  nobody clicks before `OPERATOR_TIMEOUT_MS`, the hook exits 0 with no output and Claude
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
      { "hooks": [{ "type": "command", "command": "$HOME/code/ai/session-operator/bin/operator-hook", "timeout": 180 }] }
    ],
    "Notification": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/ai/session-operator/bin/operator-hook", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/ai/session-operator/bin/operator-hook", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/ai/session-operator/bin/operator-hook", "timeout": 5 }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "$HOME/code/ai/session-operator/bin/operator-hook", "timeout": 5 }] }
    ]
  }
}
```

The `PermissionRequest` timeout (180s) needs to be above `OPERATOR_TIMEOUT_MS` (120s) plus
one 30s poll, so the hook falls back on its own before Claude Code kills it. Killed
would still be safe though, Claude Code just shows the prompt.

Heads up: while the hook is waiting, the terminal prompt may not show until it gives
up. If that gets annoying, lower `OPERATOR_TIMEOUT_MS` (e.g. `"command": "OPERATOR_TIMEOUT_MS=45000 $HOME/code/ai/session-operator/bin/operator-hook"`).

## Try it without installing the hook

```sh
pnpm start &
echo '{"hook_event_name":"PermissionRequest","session_id":"demo","cwd":"/tmp/demo","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | bin/operator-hook
# click Approve at http://127.0.0.1:4477 and the hook prints its decision JSON
```
