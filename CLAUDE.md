# session operator

A local dashboard for every Claude Code session on this Mac, plus an "operator" session that
runs the others. Hono server on 127.0.0.1:4477, React + Tailwind v4 web app (Matrix theme).

## Map

- `server/index.ts` - HTTP API, hook endpoints, nudge loop
- `server/sessions.ts` - reads `~/.claude/projects/*/*.jsonl` transcripts into `Session`s
- `server/refs.ts` - card/issue/PR refs for a session, one adapter per tracker (Shortcut, GitHub)
- `server/next-action.ts` - what a session needs from the user
- `server/reply.ts` - types into a session's iTerm tab or tmux pane, `closeSession` (`/exit` + close it)
- `web/src/` - `App.tsx` (list + operator strip), `SessionDetail.tsx` (panel), `Refs.tsx`
- `bin/operator-hook` - the Claude Code hook; posts each event to the server
- `bin/sop` - the operator's CLI (`ls`, `feed`, `say`, `end`, `start`, `operator`)
- `docs/operator-prompt.md` - appended to the operator's system prompt

## Running it

- `pnpm start` runs the server with no watch. After a server change:
  `pnpm build`, then `lsof -ti tcp:4477 -sTCP:LISTEN | xargs kill; (nohup pnpm start >| .deck.log 2>&1 &)`
- Web-only change: `pnpm build` is enough, then reload the page.
- `pnpm typecheck` before saying a change is done. There are no tests.

## Wiring

- Hooks live in `~/.claude/settings.json` (SessionEnd, PermissionRequest, Notification, Stop,
  UserPromptSubmit), all pointing at `bin/operator-hook`. Approvals wait on the deck for up to
  an hour; the terminal shows the same prompt meanwhile, and answering either one wins.
- `sop` is symlinked into `~/.local/bin`. Not `op`, that's 1Password.
- Env: `OPERATOR_URL`, `OPERATOR_PORT`, `OPERATOR_ROLE` (set by `sop operator`), `OPERATOR_TERMINAL` (`iterm` or `tmux`, for `sop start`, default iterm),
  `OPERATOR_NUDGES=0` and `OPERATOR_NOTIFY=0` to turn those off.
- Card refs read `SHORTCUT_API_TOKEN`. Never print it.

## Gotchas

- Messages typed while Claude is mid-turn land in the transcript as `attachment` records with
  `type: "queued_command"`, not as user messages.
- Image paths typed into a session stay plain text; Claude Code doesn't turn them into `[Image #N]`.
- POSTs must be `application/json` (CSRF guard, otherwise 415).
- A session is about a card only if its branch names one. Mentions are listed, never promoted.

## Rules

- This repo is public. No employer names, internal URLs, tokens or personal data in commits.
- Commits are authored with the repo-local `user.email`; don't change it.
- Commit only when asked.
