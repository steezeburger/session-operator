import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const REGISTRY_DIR = join(homedir(), ".claude", "sessions");
const MAX_REPLY = 4000;

// Finds the iTerm session on that tty and types the text into it, then presses Enter.
// write text's own newline is a line feed, which Claude Code reads as Ctrl+J (insert
// newline), so Enter goes separately as a carriage return, after a pause so it isn't
// swallowed as part of the pasted text.
// Values arrive as argv, never spliced into the script source.
const TYPE_INTO_ITERM = `
on run argv
  set ttyName to "/dev/" & item 1 of argv
  set msg to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is ttyName then
            tell s to write text msg newline no
            delay 0.15
            tell s to write text (ASCII character 13) newline no
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

const CLOSE_ITERM_SESSION = `
on run argv
  set ttyName to "/dev/" & item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is ttyName then
            close s
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

/** Session id -> pid for every Claude Code process that's still registered. */
export async function liveSessions(): Promise<Map<string, number>> {
  const live = new Map<string, number>();
  let files: string[];
  try {
    files = (await readdir(REGISTRY_DIR)).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return live;
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(await readFile(join(REGISTRY_DIR, file), "utf8")) as { pid?: number; sessionId?: string };
      if (!entry.sessionId || !Number.isInteger(entry.pid)) continue;
      process.kill(entry.pid as number, 0); // throws if the process is gone
      live.set(entry.sessionId, entry.pid as number);
    } catch {
      // stale registry file or unreadable: not live
    }
  }
  return live;
}

export type ReplyResult = "sent" | "not-running" | "no-terminal";

// Where a Claude process is running: a tmux pane, or an iTerm session found by its tty.
// tmux goes first. Inside tmux (even tmux in iTerm) Claude's tty is the pane's, so iTerm
// can't find it anyway.
type Terminal = { kind: "tmux"; pane: string } | { kind: "iterm"; tty: string };

async function ttyOf(pid: number): Promise<string | null> {
  const tty = (await run("ps", ["-o", "tty=", "-p", String(pid)])).stdout.trim();
  return /^ttys\d+$/.test(tty) ? tty : null;
}

async function terminalOf(pid: number): Promise<Terminal | null> {
  const tty = await ttyOf(pid);
  if (!tty) return null;
  // Fails when no tmux server is running, which just means it's not in tmux.
  const panes = await run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"]).catch(() => ({ stdout: "" }));
  for (const line of panes.stdout.split("\n")) {
    const [paneTty, pane] = line.split(" ");
    if (paneTty === `/dev/${tty}` && pane) return { kind: "tmux", pane };
  }
  return { kind: "iterm", tty };
}

// Pastes the text into the pane (bracketed, so newlines stay newlines, like iTerm), then
// presses Enter after the same pause. The text goes in on stdin, never through a shell.
async function typeIntoTmux(pane: string, text: string): Promise<boolean> {
  try {
    const load = run("tmux", ["load-buffer", "-b", "session-operator", "-"], { timeout: 10_000 });
    load.child.stdin?.end(text);
    await load;
    await run("tmux", ["paste-buffer", "-p", "-d", "-b", "session-operator", "-t", pane], { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 150));
    await run("tmux", ["send-keys", "-t", pane, "Enter"], { timeout: 10_000 });
    return true;
  } catch (err) {
    // The pane went away between finding it and typing into it.
    if (/can't find pane/.test(String((err as { stderr?: string }).stderr))) return false;
    throw err;
  }
}

async function typeInto(term: Terminal, text: string): Promise<boolean> {
  if (term.kind === "tmux") return typeIntoTmux(term.pane, text);
  const { stdout } = await run("osascript", ["-e", TYPE_INTO_ITERM, term.tty, text], { timeout: 10_000 });
  return stdout.trim() === "ok";
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function sendReply(sessionId: string, text: string): Promise<ReplyResult> {
  const pid = (await liveSessions()).get(sessionId);
  if (!pid) return "not-running";
  const term = await terminalOf(pid);
  if (!term) return "no-terminal";
  // iTerm types each \n as a line feed, which Claude Code takes as "new line", not submit.
  const line = text.replace(/\r\n?/g, "\n").trim().slice(0, MAX_REPLY);
  return (await typeInto(term, line)) ? "sent" : "no-terminal";
}

export type CloseResult = "closed" | "not-running" | "no-terminal" | "still-running";

// Exits Claude the normal way (/exit, so the transcript is saved), then closes its iTerm tab
// or tmux pane. If Claude is mid-turn the /exit just queues, so it stays open and we say so.
export async function closeSession(sessionId: string): Promise<CloseResult> {
  const pid = (await liveSessions()).get(sessionId);
  if (!pid) return "not-running";
  const term = await terminalOf(pid);
  if (!term) return "no-terminal";
  if (!(await typeInto(term, "/exit"))) return "no-terminal";
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
  if (alive(pid)) return "still-running";
  if (term.kind === "iterm") await run("osascript", ["-e", CLOSE_ITERM_SESSION, term.tty], { timeout: 10_000 });
  // kill-pane, not kill-window, so other panes in a split survive. A pane that ran claude
  // directly (sop start) is already gone by now, which is fine.
  else await run("tmux", ["kill-pane", "-t", term.pane]).catch(() => {});
  return "closed";
}
