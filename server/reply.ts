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

// Brings the iTerm session on that tty to the front: its tab, its window, then iTerm itself.
const FOCUS_ITERM_SESSION = `
on run argv
  set ttyName to "/dev/" & item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is ttyName then
            tell s to select
            tell t to select
            tell w to select
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

// A new iTerm tab (or window, when there's none) attached to that tmux session. exec, so
// detaching closes the tab instead of leaving a shell behind.
const ATTACH_IN_ITERM = `
on run argv
  set cmd to "exec tmux attach -t " & quoted form of ("=" & item 1 of argv)
  tell application "iTerm2"
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text cmd
    activate
  end tell
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

/** pid -> tty (ttys012) for each of those processes that has one. One ps for all of them. */
async function ttysOf(pids: number[]): Promise<Map<number, string>> {
  const ttys = new Map<number, string>();
  if (pids.length === 0) return ttys;
  // ps exits 1 when some pid is gone, with the rest still printed.
  const { stdout } = await run("ps", ["-o", "pid=,tty=", "-p", pids.join(",")]).catch((err) => ({ stdout: String(err.stdout ?? "") }));
  for (const line of stdout.split("\n")) {
    const [pid, tty] = line.trim().split(/\s+/);
    if (tty && /^ttys\d+$/.test(tty)) ttys.set(Number(pid), tty);
  }
  return ttys;
}

/** /dev tty -> tmux pane id, for every pane. Empty when no tmux server is running. */
async function tmuxPanes(): Promise<Map<string, string>> {
  const panes = new Map<string, string>();
  const { stdout } = await run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{pane_id}"]).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const [paneTty, pane] = line.split(" ");
    if (paneTty && pane) panes.set(paneTty, pane);
  }
  return panes;
}

function terminalFor(tty: string, panes: Map<string, string>): Terminal {
  const pane = panes.get(`/dev/${tty}`);
  return pane ? { kind: "tmux", pane } : { kind: "iterm", tty };
}

async function terminalOf(pid: number): Promise<Terminal | null> {
  const tty = (await ttysOf([pid])).get(pid);
  return tty ? terminalFor(tty, await tmuxPanes()) : null;
}

// Which terminal each live process is in, for the dashboard. Any tty outside tmux counts as
// iTerm without asking iTerm, which is slow; focusing one that isn't there says so then.
export async function terminalKinds(pids: number[]): Promise<Map<number, Terminal["kind"]>> {
  const [ttys, panes] = await Promise.all([ttysOf(pids), tmuxPanes()]);
  return new Map([...ttys].map(([pid, tty]) => [pid, terminalFor(tty, panes).kind]));
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

export type FocusResult = "focused" | "not-running" | "no-terminal";

async function focusIterm(tty: string): Promise<boolean> {
  const { stdout } = await run("osascript", ["-e", FOCUS_ITERM_SESSION, tty], { timeout: 10_000 });
  return stdout.trim() === "ok";
}

// Selects the pane and its window, then shows the tmux session: in the iTerm tab of the client
// you used last, or in a new iTerm tab when no client is attached (or it isn't in iTerm).
async function focusTmux(pane: string): Promise<boolean> {
  let name: string;
  try {
    name = (await run("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"])).stdout.trim();
    await run("tmux", ["select-window", "-t", pane]);
    await run("tmux", ["select-pane", "-t", pane]);
  } catch (err) {
    if (/can't find pane/.test(String((err as { stderr?: string }).stderr))) return false;
    throw err;
  }
  const clients = (await run("tmux", ["list-clients", "-t", `=${name}`, "-F", "#{client_activity} #{client_tty}"])).stdout
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([at, tty]) => at && tty?.startsWith("/dev/"))
    .sort((a, b) => Number(b[0]) - Number(a[0]));
  const client = clients[0]?.[1];
  if (client && (await focusIterm(client.slice("/dev/".length)))) return true;
  await run("osascript", ["-e", ATTACH_IN_ITERM, name], { timeout: 10_000 });
  return true;
}

export async function focusSession(sessionId: string): Promise<FocusResult> {
  const pid = (await liveSessions()).get(sessionId);
  if (!pid) return "not-running";
  const term = await terminalOf(pid);
  if (!term) return "no-terminal";
  const ok = term.kind === "tmux" ? await focusTmux(term.pane) : await focusIterm(term.tty);
  return ok ? "focused" : "no-terminal";
}
