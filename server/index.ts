import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { scanSessions } from "./sessions.ts";
import type { Behavior, DeckState, PendingDecision, Session, SessionStatus } from "./types.ts";

const PORT = Number(process.env.DECK_PORT ?? 4477);
const HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 120_000;
const WAIT_SLICE_MS = 25_000;

interface Decision {
  behavior: Behavior;
  message?: string;
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
const listeners = new Set<() => void>();

function changed() {
  for (const fn of listeners) fn();
}

// osascript gets the text as argv, never interpolated into the script.
function notify(title: string, message: string) {
  if (process.env.DECK_NOTIFY === "0") return;
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
  const direct = str(i.command) ?? str(i.file_path) ?? str(i.notebook_path) ?? str(i.url) ?? str(i.pattern);
  if (direct) return direct;
  const json = JSON.stringify(input) ?? "";
  return json.length > 300 ? `${json.slice(0, 299)}…` : json || toolName;
}

function projectName(cwd: string | undefined) {
  return cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : "unknown";
}

function dropPendingFor(sessionId: string) {
  for (const [id, entry] of pending) {
    if (entry.sessionId === sessionId && !entry.decision) {
      pending.delete(id);
      for (const w of entry.waiters) w();
    }
  }
}

function setHookStatus(sessionId: string, status: SessionStatus, detail: string, cwd?: string) {
  hookStatus.set(sessionId, { status, detail, at: Date.now(), cwd });
}

const STATUS_ORDER: Record<SessionStatus, number> = { waiting: 0, done: 1, working: 2, idle: 3 };

async function buildState(): Promise<DeckState> {
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
        status: hs.status,
        statusDetail: hs.detail,
        lastActivity: new Date(hs.at).toISOString(),
      });
    } else if (hs.at >= new Date(s.lastActivity).getTime()) {
      s.status = hs.status;
      s.statusDetail = hs.detail;
    }
  }

  const pendingList = [...pending.values()]
    .filter((p) => !p.decision)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ waiters: _w, decision: _d, ...rest }) => rest);

  for (const p of pendingList) {
    const s = byId.get(p.sessionId);
    if (s) {
      s.status = "waiting";
      s.statusDetail = `Needs approval: ${p.toolName}`;
    }
  }

  const sessions = [...byId.values()].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.lastActivity.localeCompare(a.lastActivity),
  );
  return { pending: pendingList, sessions };
}

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
  const project = projectName(cwd);

  switch (event) {
    case "PermissionRequest": {
      const toolName = str(body.tool_name) ?? "tool";
      const timeoutMs = Number(body.deck_timeout_ms) || DEFAULT_TIMEOUT_MS;
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
      notify(`${project} needs approval`, `${toolName}: ${entry.summary}`);
      changed();
      return c.json({ id: entry.id });
    }
    case "Notification": {
      const type = str(body.notification_type);
      const message = str(body.message) ?? "Waiting for you";
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
      setHookStatus(sessionId, "done", "Finished its turn, your move", cwd);
      break;
    case "SessionEnd":
      dropPendingFor(sessionId);
      setHookStatus(sessionId, "idle", "Session ended", cwd);
      break;
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      // The tool ran or a new prompt came in, so any open request was answered elsewhere.
      if (event !== "PreToolUse") dropPendingFor(sessionId);
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
  for (const w of entry.waiters) w();
  // If no hook is listening anymore, forget it after a short grace period.
  setTimeout(() => pending.delete(entry.id), 30_000);
  setHookStatus(entry.sessionId, "working", "Working", entry.cwd);
  changed();
  return c.json({ ok: true });
});

app.get("/api/state", async (c) => c.json(await buildState()));

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
  console.log(`session deck server on http://${HOST}:${PORT}`);
});
