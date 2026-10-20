import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { nextActionFor } from "./next-action.ts";
import { refLinks, refsFor } from "./refs.ts";
import { closeSession, liveSessions, sendReply } from "./reply.ts";
import { fullReplies, mentionCounts, questionAnsweredSince, readFeed, scanSessions } from "./sessions.ts";
import type { Behavior, OperatorState, PendingDecision, Session, SessionStatus } from "./types.ts";

const PORT = Number(process.env.OPERATOR_PORT ?? 4477);
const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 120_000;
const WAIT_SLICE_MS = 25_000;

interface Decision {
  behavior: Behavior;
  message?: string;
  /** Replaces the tool's input on allow. AskUserQuestion takes its answers this way. */
  updatedInput?: Record<string, unknown>;
}

interface PendingEntry extends PendingDecision {
  decision?: Decision;
  waiters: Set<() => void>;
}

interface HookStatus {
  status: SessionStatus;
  detail: string;
  at: number;
  cwd?: string;
}

const pending = new Map<string, PendingEntry>();
const hookStatus = new Map<string, HookStatus>();
// The tool each session last asked permission for, so a fallback "needs your permission"
// notification can say what it's really about.
const lastAsk = new Map<string, string>();
const QUESTIONS_DETAIL = "Has questions for you";

// The one session started with `sop operator`. Kept on disk so a server restart doesn't forget
// it, and so `sop operator` can resume the same session next time. A newer one replaces it.
const ROLES_FILE = join(tmpdir(), "session-operator-roles.json");
const operatorIds = new Set<string>(
  (() => {
    try {
      return (JSON.parse(readFileSync(ROLES_FILE, "utf8")) as string[]).slice(-1);
    } catch {
      return [];
    }
  })(),
);
function markOperator(sessionId: string) {
  if (operatorIds.has(sessionId)) return;
  operatorIds.clear();
  operatorIds.add(sessionId);
  void writeFile(ROLES_FILE, JSON.stringify([...operatorIds])).catch(() => {});
}
const listeners = new Set<() => void>();

function changed() {
  for (const fn of listeners) fn();
}

// osascript gets the text as argv, never interpolated into the script.
function notify(title: string, message: string) {
  if (process.env.OPERATOR_NOTIFY === "0") return;
  execFile(
    "osascript",
    [
      "-e",
      "on run argv",
      "-e",
      'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
      "-e",
      "end run",
      title,
      message.slice(0, 200),
    ],
    () => {},
  );
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function summarize(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === "AskUserQuestion" && Array.isArray(i.questions)) {
    return (i.questions as { question?: string }[]).map((q) => q.question ?? "").join("\n");
  }
  const direct = str(i.command) ?? str(i.file_path) ?? str(i.notebook_path) ?? str(i.url) ?? str(i.pattern);
  if (direct) return direct;
  const json = JSON.stringify(input) ?? "";
  return json.length > 300 ? `${json.slice(0, 299)}…` : json || toolName;
}

function projectName(cwd: string | undefined) {
  return cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : "unknown";
}

// Waking the waiters tells a hook still polling that it's gone, so it exits.
function dropEntry(entry: PendingEntry) {
  pending.delete(entry.id);
  for (const w of entry.waiters) w();
}

function dropPendingFor(sessionId: string) {
  for (const entry of pending.values()) {
    if (entry.sessionId === sessionId && !entry.decision) dropEntry(entry);
  }
}

// A card is only worth showing while a hook is waiting on it. Past its deadline the hook
// has let go, and a question answered in the terminal needs nothing from the deck.
async function dropStale() {
  const now = Date.now();
  await Promise.all(
    [...pending.values()]
      .filter((e) => !e.decision)
      .map(async (e) => {
        const stale =
          now > new Date(e.expiresAt).getTime() ||
          (e.toolName === "AskUserQuestion" && (await questionAnsweredSince(e.sessionId, new Date(e.createdAt).getTime())));
        if (stale) dropEntry(e);
      }),
  );
}

function setHookStatus(sessionId: string, status: SessionStatus, detail: string, cwd?: string) {
  hookStatus.set(sessionId, { status, detail, at: Date.now(), cwd });
}

const STATUS_ORDER: Record<SessionStatus, number> = { failing: 0, waiting: 1, done: 1, blocked: 2, working: 3, idle: 4, closed: 5 };
// Closed sessions stay listed this long after their last activity, then drop off.
const CLOSED_SHOWN_MS = 24 * 60 * 60 * 1000;

async function buildState(): Promise<OperatorState> {
  const fromTranscripts = await scanSessions();
  const byId = new Map<string, Session>(fromTranscripts.map((s) => [s.id, s]));

  for (const [id, hs] of hookStatus) {
    const s = byId.get(id);
    if (!s) {
      if (!hs.cwd) continue;
      byId.set(id, {
        id,
        cwd: hs.cwd,
        project: projectName(hs.cwd),
        branch: null,
        title: null,
        lastPrompt: null,
        lastReply: null,
        nextAction: null,
        nextUrl: null,
        nextSay: null,
        nextLoading: false,
        live: false,
        blockedOn: null,
        refs: [],
        refLinks: { shortcut: null, github: null },
        status: hs.status,
        statusDetail: hs.detail,
        turnEnd: null,
        role: null,
        lastActivity: new Date(hs.at).toISOString(),
      });
    } else if (hs.at >= new Date(s.lastActivity).getTime()) {
      s.status = hs.status;
      s.statusDetail = hs.detail;
    }
  }

  const live = await liveSessions();
  for (const [id, s] of byId) {
    s.live = live.has(id);
    if (operatorIds.has(id)) s.role = "operator";
    if (s.live) continue;
    // No Claude process behind it: whatever the transcript last said, nobody can act on it now.
    if (Date.now() - new Date(s.lastActivity).getTime() > CLOSED_SHOWN_MS) {
      byId.delete(id);
      continue;
    }
    s.status = "closed";
    s.statusDetail = "Closed";
  }

  // "Your move" sessions get a specific next step from Haiku; the regex guess stays as fallback.
  for (const s of byId.values()) {
    const text = fullReplies.get(s.id);
    // The operator is the controller, not a worker: no next step of its own.
    const finishedIdle = s.status === "idle" && s.live && s.turnEnd === "finished";
    if (s.role === "operator" || (s.status !== "done" && s.status !== "working" && !finishedIdle) || !text) continue;
    const ai = nextActionFor(s.id, s.cwd, text, changed);
    // An old finished turn goes idle, unless its last message still asks something of you.
    if (finishedIdle) {
      if (!ai?.needsUser) continue;
      s.status = "done";
      s.statusDetail = "Finished its turn, your move";
    }
    // A working session only borrows "waiting on X" (e.g. polling a deploy); its asks aren't final yet.
    if (s.status === "working") {
      if (ai?.blockedOn) {
        s.status = "blocked";
        s.blockedOn = ai.blockedOn;
      }
      continue;
    }
    if (ai === undefined) s.nextLoading = s.nextAction === null;
    else if (ai) {
      // Claude's own "Next:" line is the step, verbatim. Haiku only fills in when there isn't one.
      const explicit = /\bNext:/i.test(text) ? s.nextAction : null;
      s.nextAction = explicit ?? ai.action;
      s.nextUrl = ai.url;
      s.nextSay = ai.say && !s.nextAction.includes(ai.say) ? ai.say : null;
      if (ai.blockedOn) {
        s.status = "blocked";
        s.blockedOn = ai.blockedOn;
      }
    }
  }

  await Promise.all(
    [...byId.values()].map(async (s) => {
      s.refLinks = await refLinks(s.cwd);
      if (s.status === "idle" || s.role === "operator") return;
      s.refs = await refsFor(s.cwd, s.branch, mentionCounts.get(s.id) ?? new Map(), changed);
    }),
  );

  await dropStale();
  const pendingList = [...pending.values()]
    .filter((p) => !p.decision)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ waiters: _w, decision: _d, ...rest }) => rest);

  for (const p of pendingList) {
    const s = byId.get(p.sessionId);
    if (s) {
      s.status = "waiting";
      s.statusDetail = p.toolName === "AskUserQuestion" ? QUESTIONS_DETAIL : `Needs approval: ${p.toolName}`;
    }
  }

  const sessions = [...byId.values()].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.lastActivity.localeCompare(a.lastActivity),
  );
  return { pending: pendingList, sessions };
}

// Nudges: when a worker has needed you for a while, the operator session hears about it.
// Each state nudges once, only after it has lasted NUDGE_DELAY_MS (so a tab you're already
// answering stays quiet), at most one bundled message per NUDGE_GAP_MS, and never while
// the operator is mid-turn. OPERATOR_NUDGES=0 turns them off.
const NUDGE_DELAY_MS = 2 * 60 * 1000;
const NUDGE_GAP_MS = 2 * 60 * 1000;
const NUDGE_TICK_MS = 30 * 1000;
const NUDGE_STATUSES: SessionStatus[] = ["waiting", "done", "failing"];
const nudgeFirstSeen = new Map<string, number>();
const nudged = new Set<string>();
let lastNudgeAt = 0;

function sessionLabel(s: Session): string {
  const card = s.refs.find((r) => r.source === "own" && r.kind === "card");
  return card ? card.label : s.branch && s.branch !== "main" ? `${s.project} (${s.branch})` : s.project;
}

async function nudgeTick() {
  if (process.env.OPERATOR_NUDGES === "0") return;
  const { sessions } = await buildState();
  const op = sessions.find((s) => s.role === "operator" && s.live);
  if (!op) return;
  const now = Date.now();
  const current = new Set<string>();
  const ready: { key: string; line: string }[] = [];
  for (const s of sessions) {
    if (s.role === "operator" || !s.live || !NUDGE_STATUSES.includes(s.status)) continue;
    const what = s.status === "done" ? (s.nextAction ?? "finished its turn") : s.statusDetail;
    const key = `${s.id}|${s.status}|${what}`;
    current.add(key);
    if (!nudgeFirstSeen.has(key)) nudgeFirstSeen.set(key, now);
    if (nudged.has(key) || now - (nudgeFirstSeen.get(key) ?? now) < NUDGE_DELAY_MS) continue;
    ready.push({ key, line: s.status === "failing" ? `${sessionLabel(s)} (failing)` : sessionLabel(s) });
  }
  for (const key of nudgeFirstSeen.keys()) {
    if (!current.has(key)) {
      nudgeFirstSeen.delete(key);
      nudged.delete(key);
    }
  }
  if (ready.length === 0 || now - lastNudgeAt < NUDGE_GAP_MS) return;
  if (op.status === "working" || op.status === "waiting" || op.status === "blocked") return;
  // Names only. The details are one click away; a summary of each one is just noise.
  const text = `[operator nudge] ${ready.map((r) => r.line).join(", ")}`;
  const result = await sendReply(op.id, text).catch(() => null);
  if (result !== "sent") return;
  lastNudgeAt = now;
  for (const r of ready) nudged.add(r.key);
}

setInterval(() => void nudgeTick().catch(() => {}), NUDGE_TICK_MS);

const app = new Hono();

// Localhost only: reject DNS-rebinding hosts and cross-site browser requests.
app.use("/api/*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return c.text("forbidden host", 403);
  const origin = c.req.header("origin");
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return c.text("forbidden origin", 403);
  }
  if (c.req.method === "POST" && !c.req.header("content-type")?.includes("application/json")) {
    return c.text("json only", 415);
  }
  await next();
});

app.post("/api/hook", async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>;
  const event = str(body.hook_event_name) ?? "";
  const sessionId = str(body.session_id) ?? "unknown";
  const cwd = str(body.cwd);
  if (body.operator_role === "operator") markOperator(sessionId);
  const project = projectName(cwd);

  switch (event) {
    case "PermissionRequest": {
      const toolName = str(body.tool_name) ?? "tool";
      const timeoutMs = Number(body.operator_timeout_ms) || DEFAULT_TIMEOUT_MS;
      const now = Date.now();
      const entry: PendingEntry = {
        id: randomUUID(),
        sessionId,
        cwd: cwd ?? "",
        toolName,
        summary: summarize(toolName, body.tool_input),
        toolInput: body.tool_input ?? null,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + timeoutMs).toISOString(),
        waiters: new Set(),
      };
      pending.set(entry.id, entry);
      lastAsk.set(sessionId, toolName);
      notify(`${project} needs approval`, `${toolName}: ${entry.summary}`);
      changed();
      return c.json({ id: entry.id });
    }
    case "Notification": {
      const type = str(body.notification_type);
      // An AskUserQuestion the deck didn't answer in time shows up as "Claude needs your permission".
      const message = lastAsk.get(sessionId) === "AskUserQuestion" ? QUESTIONS_DETAIL : (str(body.message) ?? "Waiting for you");
      if (type === "idle_prompt") {
        setHookStatus(sessionId, "done", "Finished its turn, your move", cwd);
      } else {
        setHookStatus(sessionId, "waiting", message, cwd);
        const alreadyPinged = [...pending.values()].some((p) => p.sessionId === sessionId);
        if (!alreadyPinged) notify(`${project} is waiting`, message);
      }
      break;
    }
    case "Stop":
      dropPendingFor(sessionId);
      lastAsk.delete(sessionId);
      setHookStatus(sessionId, "done", "Finished its turn, your move", cwd);
      break;
    case "SessionEnd":
      dropPendingFor(sessionId);
      lastAsk.delete(sessionId);
      setHookStatus(sessionId, "closed", "Session ended", cwd);
      break;
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      // The tool ran or a new prompt came in, so any open request was answered elsewhere.
      if (event !== "PreToolUse") {
        dropPendingFor(sessionId);
        lastAsk.delete(sessionId);
      }
      setHookStatus(sessionId, "working", "Working", cwd);
      break;
  }
  changed();
  return c.json({});
});

// Long-poll: resolves when decided, expired, or after one slice (hook loops).
app.get("/api/decisions/:id/wait", async (c) => {
  const entry = pending.get(c.req.param("id"));
  if (!entry) return c.json({ status: "gone" });
  if (!entry.decision) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        entry.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, WAIT_SLICE_MS);
      entry.waiters.add(done);
    });
  }
  if (!entry.decision) return c.json({ status: pending.has(entry.id) ? "pending" : "gone" });
  pending.delete(entry.id);
  return c.json({ status: "decided", ...entry.decision });
});

app.post("/api/decisions/:id", async (c) => {
  const entry = pending.get(c.req.param("id"));
  if (!entry || entry.decision) return c.json({ error: "not pending" }, 404);
  const body = (await c.req.json()) as Record<string, unknown>;
  if (body.behavior !== "allow" && body.behavior !== "deny") {
    return c.json({ error: "behavior must be allow or deny" }, 400);
  }
  entry.decision = { behavior: body.behavior, message: str(body.message) };
  // Picked answers to an AskUserQuestion: question text -> chosen label(s), comma-joined.
  if (body.behavior === "allow" && entry.toolName === "AskUserQuestion" && body.answers && typeof body.answers === "object") {
    const answers = Object.fromEntries(
      Object.entries(body.answers as Record<string, unknown>).filter((kv): kv is [string, string] => typeof kv[1] === "string"),
    );
    entry.decision.updatedInput = { ...(entry.toolInput as Record<string, unknown>), answers };
  }
  for (const w of entry.waiters) w();
  // If no hook is listening anymore, forget it after a short grace period.
  setTimeout(() => pending.delete(entry.id), 30_000);
  setHookStatus(entry.sessionId, "working", "Working", entry.cwd);
  changed();
  return c.json({ ok: true });
});

app.get("/api/state", async (c) => c.json(await buildState()));

app.post("/api/sessions/:id/reply", async (c) => {
  const { text } = (await c.req.json()) as { text?: unknown };
  if (typeof text !== "string" || !text.trim()) return c.json({ error: "empty reply" }, 400);
  try {
    const result = await sendReply(c.req.param("id"), text);
    if (result === "not-running") return c.json({ error: "That session isn't running anymore" }, 409);
    if (result === "not-in-iterm") return c.json({ error: "Couldn't find its iTerm tab" }, 409);
  } catch {
    return c.json({ error: "iTerm refused - allow Automation for iTerm in System Settings" }, 500);
  }
  return c.json({ ok: true });
});

// Images dropped into a reply. Saved to a temp file; the reply then types the path, which
// Claude Code turns into an attached image.
const UPLOAD_DIR = join(tmpdir(), "session-operator-uploads");
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

app.post("/api/uploads", async (c) => {
  const { type, data } = (await c.req.json()) as { type?: unknown; data?: unknown };
  const ext = typeof type === "string" ? IMAGE_TYPES[type] : undefined;
  if (!ext || typeof data !== "string") return c.json({ error: "png, jpeg, gif or webp only" }, 400);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return c.json({ error: "image must be under 10MB" }, 413);
  await mkdir(UPLOAD_DIR, { recursive: true });
  const path = join(UPLOAD_DIR, `${randomUUID()}.${ext}`);
  await writeFile(path, bytes);
  return c.json({ path });
});

app.post("/api/sessions/:id/close", async (c) => {
  try {
    const result = await closeSession(c.req.param("id"));
    if (result === "not-running") return c.json({ error: "That session isn't running anymore" }, 409);
    if (result === "not-in-iterm") return c.json({ error: "Couldn't find its iTerm tab" }, 409);
    if (result === "still-running") return c.json({ error: "Claude is busy - /exit is queued, tab left open" }, 409);
  } catch {
    return c.json({ error: "iTerm refused - allow Automation for iTerm in System Settings" }, 500);
  }
  changed();
  return c.json({ ok: true });
});

// The last ?limit= items (default 40); X-Feed-Total says how many there are in all.
app.get("/api/sessions/:id/feed", async (c) => {
  const feed = await readFeed(c.req.param("id"));
  if (!feed) return c.text("not found", 404);
  const limit = Math.max(1, Number(c.req.query("limit")) || 40);
  c.header("X-Feed-Total", String(feed.length));
  return c.json(feed.slice(-limit));
});

app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    let wake: () => void = () => {};
    const listener = () => wake();
    listeners.add(listener);
    stream.onAbort(() => {
      listeners.delete(listener);
      wake();
    });
    await stream.writeSSE({ event: "change", data: "" });
    while (!stream.aborted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 15_000);
      });
      if (stream.aborted) break;
      await stream.writeSSE({ event: "change", data: "" });
    }
  }),
);

setInterval(() => {
  const now = Date.now();
  let any = false;
  for (const [id, entry] of pending) {
    if (!entry.decision && new Date(entry.expiresAt).getTime() < now) {
      pending.delete(id);
      for (const w of entry.waiters) w();
      any = true;
    }
  }
  if (any) changed();
}, 5_000);

const dist = fileURLToPath(new URL("../web/dist", import.meta.url));
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: dist }));
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`session operator server on http://${HOST}:${PORT}`);
});
