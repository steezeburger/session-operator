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

export type ReplyResult = "sent" | "not-running" | "not-in-iterm";

export async function sendReply(sessionId: string, text: string): Promise<ReplyResult> {
  const pid = (await liveSessions()).get(sessionId);
  if (!pid) return "not-running";
  const tty = (await run("ps", ["-o", "tty=", "-p", String(pid)])).stdout.trim();
  if (!/^ttys\d+$/.test(tty)) return "not-in-iterm";
  // A newline would submit early, so a multi-line reply goes in as one line.
  const line = text.replace(/\s*\n\s*/g, " ").trim().slice(0, MAX_REPLY);
  const { stdout } = await run("osascript", ["-e", TYPE_INTO_ITERM, tty, line], { timeout: 10_000 });
  return stdout.trim() === "ok" ? "sent" : "not-in-iterm";
}
