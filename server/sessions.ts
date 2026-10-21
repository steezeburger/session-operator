import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { countMentions } from "./refs.ts";
import type { FeedItem, Session, SessionStatus } from "./types.ts";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");
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
  customTitle?: string;
  lastPrompt?: string;
  isApiErrorMessage?: boolean;
  message?: { stop_reason?: string | null; content?: unknown };
  attachment?: { type?: string; prompt?: unknown; origin?: { kind?: string } };
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

// Keep the end: a question or ask for the user usually comes last.
function clipTail(text: string | undefined, max = 280): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  // Start at a sentence, or at least a word, so it doesn't open mid-word.
  const cut = oneLine.slice(-(max - 1));
  const sentence = cut.search(/[.!?:]\s+\S/);
  if (sentence >= 0 && sentence < max / 2) return `…${cut.slice(sentence + 1).replace(/^[\s>#*-]+/, "")}`;
  const word = cut.indexOf(" ");
  return `…${word >= 0 && word < 30 ? cut.slice(word + 1) : cut}`;
}

function assistantText(r: TranscriptRecord): string | undefined {
  const content = r.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b) => (b as { type?: string })?.type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("\n")
    .trim();
  return text || undefined;
}

// Claude's replies end with "Next: <one action>"; that line is the step. Failing that,
// the last question it asked is what the user has to answer.
export function extractNextAction(text: string | undefined): string | null {
  if (!text) return null;
  const next = [...text.matchAll(/(?:^|\n|\. )\**Next:?\**:?\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/gi)].pop()?.[1];
  if (next) return clip(next, 240);
  const question = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((p) => p.trim())
    .filter((p) => p.endsWith("?"))
    .pop();
  return question ? clip(`Answer: ${question}`, 240) : null;
}

/** Full text of each session's last Claude message, for next-action inference. Not sent to the UI. */
export const fullReplies = new Map<string, string>();

/** Card/PR mention counts across each session's recent Claude messages. */
export const mentionCounts = new Map<string, Map<string, number>>();

// What you typed: a plain user message, or one typed while Claude was mid-turn.
function typedPrompt(r: TranscriptRecord): string | null {
  const a = r.attachment;
  if (r.type === "attachment" && a?.type === "queued_command" && a.origin?.kind === "human" && typeof a.prompt === "string") return a.prompt.trim() || null;
  const content = r.message?.content;
  if (r.type !== "user" || typeof content !== "string") return null;
  return content.trimStart().startsWith("<") ? null : content.trim() || null;
}

const PROMPTS_KEPT = 20;

// The /rename title and your recent messages, from the whole transcript once and then only
// what's appended. Both can sit far before the tail parseTranscript sees: in a long session
// tool output fills that, and a rename happens whenever.
interface History {
  offset: number;
  title: string | null;
  prompts: string[];
  /** The first record's time, so when the session started. */
  startedAt: string | null;
}
const histories = new Map<string, History>();
async function history(path: string, size: number): Promise<History> {
  let h = histories.get(path);
  if (!h || size < h.offset) h = { offset: 0, title: null, prompts: [], startedAt: null };
  if (size > h.offset) {
    const text = await readFrom(path, h.offset, size);
    const end = text.lastIndexOf("\n") + 1;
    const prompts = [...h.prompts];
    let title = h.title;
    let startedAt = h.startedAt;
    for (const line of text.slice(0, end).split("\n")) {
      startedAt ??= line.match(/"timestamp":"([^"]+)"/)?.[1] ?? null;
      // Skip the parse for everything that can't be a rename or something you typed.
      if (!line.includes('"custom-title"') && !line.includes('"queued_command"') && !line.includes('"type":"user"')) continue;
      try {
        const r = JSON.parse(line) as TranscriptRecord;
        if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
        const typed = !r.isSidechain && typedPrompt(r);
        if (typed) prompts.push(clip(typed, 100) ?? "");
      } catch {
        // half-written line
      }
    }
    h = { offset: h.offset + Buffer.byteLength(text.slice(0, end)), title, prompts: prompts.slice(-PROMPTS_KEPT), startedAt };
  }
  histories.set(path, h);
  return h;
}

export function parseTranscript(id: string, text: string, mtime: Date): Session | null {
  let cwd: string | undefined;
  let branch: string | undefined;
  let title: string | undefined;
  let lastPrompt: string | undefined;
  let customTitle: string | undefined;
  const prompts: string[] = [];
  let lastTurn: TranscriptRecord | undefined;
  let lastReply: string | undefined;
  const counts = new Map<string, number>();

  for (const line of text.split("\n")) {
    if (!line) continue;
    let r: TranscriptRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.cwd) cwd = r.cwd;
    // Once a session removes its own worktree, git reports HEAD; keep the last real branch.
    if (r.gitBranch && r.gitBranch !== "HEAD") branch = r.gitBranch;
    if (r.type === "ai-title" && r.aiTitle) title = r.aiTitle;
    if (r.type === "last-prompt" && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.type === "custom-title" && r.customTitle) customTitle = r.customTitle;
    if (r.isSidechain) continue;
    const typed = typedPrompt(r);
    if (typed) prompts.push(typed);
    if (r.type === "user" || r.type === "assistant") lastTurn = r;
    if (r.type === "assistant") {
      const said = assistantText(r);
      if (said) countMentions(said, counts);
      lastReply = said ?? lastReply;
    }
    if (r.type === "system" && (r.subtype === "turn_duration" || r.subtype === "api_error")) lastTurn = r;
  }
  if (!cwd || !lastTurn) return null;
  if (lastReply) fullReplies.set(id, lastReply);
  mentionCounts.set(id, counts);

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
    repo: null,
    branch: branch ?? null,
    title: clip(title, 80),
    customTitle: clip(customTitle, 80),
    topic: null,
    recentPrompts: prompts.slice(-6).map((p) => clip(p, 100) ?? ""),
    lastPrompt: clip(lastPrompt),
    lastReply: clipTail(lastReply),
    nextAction: extractNextAction(lastReply),
    nextUrl: null,
    nextSays: [],
    effort: null,
    nextLoading: false,
    live: false,
    blockedOn: null,
    refs: [],
    refLinks: { shortcut: null, github: null },
    mergedInto: null,
    status,
    statusDetail,
    role: null,
    turnEnd: apiError || (lastTurn.type === "user" && hasToolError(lastTurn)) ? "failing" : turnEnded ? "finished" : "mid-turn",
    paused: null,
    startedAt: null,
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
        if (session) {
          const h = await history(path, info.size);
          session.customTitle = clip(h.title ?? undefined, 80) ?? session.customTitle;
          if (h.prompts.length > session.recentPrompts.length) session.recentPrompts = h.prompts;
          session.startedAt = h.startedAt;
          sessions.push(session);
        }
      } catch {
        // unreadable or vanished transcript: skip it
      }
    }
  }
  return sessions;
}

const FEED_TEXT_MAX = 4000;
const SESSION_ID_RE = /^[0-9a-f-]{36}$/;

function toolLine(block: { name?: string; input?: Record<string, unknown> }): string {
  const i = block.input ?? {};
  const pick = [i.description, i.command, i.file_path, i.pattern, i.url, i.prompt].find((v) => typeof v === "string");
  return `${block.name ?? "tool"}${pick ? `: ${pick}` : ""}`;
}

// Long messages lose their middle: the opening says what it's about, the end holds the ask.
function clipFeed(text: string): string {
  if (text.length <= FEED_TEXT_MAX) return text;
  const head = Math.floor(FEED_TEXT_MAX * 0.3);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (FEED_TEXT_MAX - head - 3))}`;
}

// One transcript line as feed items. Same rule as the scan: read fields, never act on them.
// "<command-name>/push</command-name>...<command-args>x</command-args>" -> "/push x",
// "<bash-input>gs</bash-input>" -> "! gs". Anything else tagged is the harness talking.
function typedCommand(content: string): string | null {
  const tag = (name: string) => content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
  const bash = tag("bash-input");
  if (bash) return `! ${bash}`;
  const name = tag("command-name");
  if (!name) return null;
  const args = tag("command-args");
  return args ? `${name} ${args}` : name;
}

function feedItems(line: string): FeedItem[] {
  let r: TranscriptRecord;
  try {
    r = JSON.parse(line);
  } catch {
    return [];
  }
  if (r.isSidechain) return [];
  const at = r.timestamp ?? null;
  // Messages typed while Claude is mid-turn are stored as queued_command attachments, not user records.
  const a = r.attachment;
  if (r.type === "attachment" && a?.type === "queued_command" && a.origin?.kind === "human" && typeof a.prompt === "string") {
    return a.prompt.trim() ? [{ kind: "user", text: clipFeed(a.prompt.trim()), at }] : [];
  }
  if (r.type !== "user" && r.type !== "assistant") return [];
  const content = r.message?.content;
  if (r.isApiErrorMessage) return [{ kind: "error", text: clipFeed(assistantText(r) ?? "API error"), at }];
  if (typeof content === "string") {
    if (r.type !== "user") return [];
    // Harness-injected user records (reminders, command output) start with a tag. Slash and
    // ! commands do too, but those you typed, so they show as you typed them.
    const typed = content.trimStart().startsWith("<") ? typedCommand(content) : content;
    return typed ? [{ kind: "user", text: clipFeed(typed), at }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: FeedItem[] = [];
  for (const b of content as { type?: string; text?: string; is_error?: boolean; content?: unknown }[]) {
    if (b?.type === "text" && b.text?.trim()) {
      if (r.type === "user" && b.text.trimStart().startsWith("<")) continue;
      out.push({ kind: r.type === "user" ? "user" : "assistant", text: clipFeed(b.text.trim()), at });
    } else if (b?.type === "tool_use") {
      out.push({ kind: "tool", text: clipFeed(toolLine(b as { name?: string; input?: Record<string, unknown> })), at });
    } else if (b?.type === "tool_result" && b.is_error) {
      const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      out.push({ kind: "error", text: clipFeed(text), at });
    }
  }
  return out;
}

// Whole-transcript feeds, parsed once and then only the bytes appended since. The panel
// polls every few seconds, and transcripts run to tens of MB.
const feedCache = new Map<string, { offset: number; items: FeedItem[] }>();

async function readFrom(path: string, from: number, size: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(size - from);
    await handle.read(buf, 0, buf.length, from);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function findTranscript(id: string): Promise<{ path: string; size: number } | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const path = join(PROJECTS_DIR, dir, `${id}.jsonl`);
    try {
      return { path, size: (await stat(path)).size };
    } catch {
      // not in this project dir
    }
  }
  return null;
}

/**
 * True if a `toolName` call got its result at or after `since` (ms): the question was answered
 * or the approval decided, wherever that happened.
 */
export async function toolResolvedSince(id: string, toolName: string, since: number): Promise<boolean> {
  const found = await findTranscript(id);
  if (!found) return false;
  const asks = new Set<string>();
  for (const line of (await readTail(found.path, found.size)).split("\n")) {
    let r: TranscriptRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as { type?: string; name?: string; id?: string; tool_use_id?: string }[]) {
      if (b?.type === "tool_use" && b.name === toolName && b.id) asks.add(b.id);
      else if (b?.type === "tool_result" && b.tool_use_id && asks.has(b.tool_use_id) && r.timestamp && Date.parse(r.timestamp) >= since) {
        return true;
      }
    }
  }
  return false;
}

/** The whole conversation for the detail panel, oldest first. */
export async function readFeed(id: string): Promise<FeedItem[] | null> {
  const found = await findTranscript(id);
  if (!found) return null;
  const { path, size } = found;
  let cached = feedCache.get(path);
  if (!cached || size < cached.offset) cached = { offset: 0, items: [] };
  if (size > cached.offset) {
    const text = await readFrom(path, cached.offset, size);
    // Stop at the last full line; a half-written one gets read next time.
    const end = text.lastIndexOf("\n") + 1;
    const items = [...cached.items];
    for (const line of text.slice(0, end).split("\n")) if (line) items.push(...feedItems(line));
    cached = { offset: cached.offset + Buffer.byteLength(text.slice(0, end)), items };
  }
  feedCache.set(path, cached);
  return cached.items;
}

/** Where a session runs and when it started, from the head of its transcript. */
export async function sessionOrigin(id: string): Promise<{ cwd: string; startedAt: number } | null> {
  const found = await findTranscript(id);
  if (!found) return null;
  let cwd: string | undefined;
  let startedAt: number | undefined;
  for (const line of (await readFrom(found.path, 0, Math.min(found.size, TAIL_BYTES))).split("\n")) {
    let r: TranscriptRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    cwd ??= r.cwd;
    if (r.timestamp) startedAt ??= Date.parse(r.timestamp);
    if (cwd && startedAt) return { cwd, startedAt };
  }
  return null;
}
