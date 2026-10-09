import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Session, SessionStatus } from "./types.ts";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const STALE_WORKING_MS = 10 * 60 * 1000;
const STALE_DONE_MS = 60 * 60 * 1000;

// Transcript records are data only: we read a few known fields and never act on content.
interface TranscriptRecord {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  aiTitle?: string;
  lastPrompt?: string;
  isApiErrorMessage?: boolean;
  message?: { stop_reason?: string | null; content?: unknown };
}

function hasToolError(r: TranscriptRecord): boolean {
  const content = r.message?.content;
  return (
    Array.isArray(content) &&
    content.some((b) => (b as { type?: string; is_error?: boolean })?.type === "tool_result" && (b as { is_error?: boolean }).is_error === true)
  );
}

async function readTail(path: string, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // Drop the first (likely partial) line when we didn't start at the beginning.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

function clip(text: string | undefined, max = 160): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function parseTranscript(id: string, text: string, mtime: Date): Session | null {
  let cwd: string | undefined;
  let branch: string | undefined;
  let title: string | undefined;
  let lastPrompt: string | undefined;
  let lastTurn: TranscriptRecord | undefined;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let r: TranscriptRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.cwd) cwd = r.cwd;
    if (r.gitBranch) branch = r.gitBranch;
    if (r.type === "ai-title" && r.aiTitle) title = r.aiTitle;
    if (r.type === "last-prompt" && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.isSidechain) continue;
    if (r.type === "user" || r.type === "assistant") lastTurn = r;
    if (r.type === "system" && (r.subtype === "turn_duration" || r.subtype === "api_error")) lastTurn = r;
  }
  if (!cwd || !lastTurn) return null;

  const lastActivity = lastTurn.timestamp ? new Date(lastTurn.timestamp) : mtime;
  const age = Date.now() - lastActivity.getTime();
  const apiError =
    (lastTurn.type === "system" && lastTurn.subtype === "api_error") || lastTurn.isApiErrorMessage === true;
  const turnEnded =
    (lastTurn.type === "system" && lastTurn.subtype === "turn_duration") ||
    (lastTurn.type === "assistant" && lastTurn.message?.stop_reason === "end_turn");

  let status: SessionStatus;
  let statusDetail: string;
  if (apiError && age <= STALE_DONE_MS) {
    status = "failing";
    statusDetail = "API error";
  } else if (turnEnded || apiError) {
    status = age > STALE_DONE_MS ? "idle" : "done";
    statusDetail = status === "done" ? "Finished its turn, your move" : "Quiet for a while";
  } else if (age > STALE_DONE_MS) {
    // Long-dead mid-turn sessions are usually just closed; don't keep them red all day.
    status = "idle";
    statusDetail = "Stopped mid-turn";
  } else if (age > STALE_WORKING_MS) {
    status = "failing";
    statusDetail = "Stuck mid-turn";
  } else if (lastTurn.type === "user" && hasToolError(lastTurn)) {
    status = "failing";
    statusDetail = "Last command failed";
  } else {
    status = "working";
    statusDetail = "Working";
  }

  return {
    id,
    cwd,
    project: basename(cwd),
    branch: branch && branch !== "HEAD" ? branch : null,
    title: clip(title, 80),
    lastPrompt: clip(lastPrompt),
    status,
    statusDetail,
    lastActivity: lastActivity.toISOString(),
  };
}

export async function scanSessions(): Promise<Session[]> {
  const sessions: Session[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_DIR);
  } catch {
    return sessions;
  }
  const cutoff = Date.now() - LOOKBACK_MS;

  for (const dir of projectDirs) {
    const full = join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = (await readdir(full)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const path = join(full, file);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) continue;
        const session = parseTranscript(
          file.replace(/\.jsonl$/, ""),
          await readTail(path, info.size),
          info.mtime,
        );
        if (session) sessions.push(session);
      } catch {
        // unreadable or vanished transcript: skip it
      }
    }
  }
  return sessions;
}
