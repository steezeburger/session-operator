import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./settings.ts";
import type { Effort, PointEvent, PointKind, Points, Session } from "./types.ts";

// An append-only ledger, one event per line. Points pay for finishing things and for the thought
// an ask took, never for speed: a bonus for fast approvals would reward not reading them.
const POINTS_FILE = join(CONFIG_DIR, "points.jsonl");
const ANSWER_POINTS = 10;
const ANSWER_POINTS_PER_MINUTE = 5;
const ANSWER_MAX_MINUTES = 20;
const QUESTION_POINTS = 15;
const APPROVAL_POINTS = 5;
const SHIPPED_POINTS = 100;
const RECENT = 10;

/** One line of the ledger. `once` keys are never paid twice. */
interface Entry extends PointEvent {
  once?: string[];
}

let entries: Entry[] = [];
let paid = new Set<string>();

// Test decks on other ports share the file, so a shipped check reads it again before paying.
function load() {
  let text = "";
  try {
    text = readFileSync(POINTS_FILE, "utf8");
  } catch {
    // no points yet
  }
  entries = text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as Entry];
    } catch {
      return [];
    }
  });
  paid = new Set(entries.flatMap((e) => e.once ?? []));
}
load();

function award(kind: PointKind, points: number, label: string, once?: string[]) {
  const entry: Entry = { id: randomUUID(), at: new Date().toISOString(), kind, points, label, ...(once ? { once } : {}) };
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(POINTS_FILE, `${JSON.stringify(entry)}\n`);
  } catch (e) {
    console.error("couldn't save points:", e);
    return;
  }
  entries.push(entry);
  for (const key of once ?? []) paid.add(key);
}

/** You answered a session that was waiting on you. A bigger ask pays more. */
export function awardAnswer(label: string, effort: Effort | null) {
  const minutes = Math.min(effort?.minutes ?? 0, ANSWER_MAX_MINUTES);
  award("answered", ANSWER_POINTS + minutes * ANSWER_POINTS_PER_MINUTE, label);
}

/** You answered a session's questions on the deck. */
export function awardQuestion(label: string) {
  award("answered", QUESTION_POINTS, label);
}

/** Flat, and the same for allow and deny, so neither is the way to score. */
export function awardApproval(label: string) {
  award("approved", APPROVAL_POINTS, label);
}

const SHIPPED_STATES = new Set(["merged", "released", "done"]);
// The last state seen for each of a session's own refs. Refs load in the background, so one
// first seen already merged shipped before now, and only a change counts. Lost on a restart,
// which only misses what merged while the deck was down.
const refStates = new Map<string, string>();
const seenAlive = new Set<string>();

function ship(s: Session, what: string, key: string) {
  const scope = `session:${s.id}|${s.branch}`;
  if (paid.has(key) || paid.has(scope)) return;
  load();
  if (paid.has(key) || paid.has(scope)) return;
  award("shipped", SHIPPED_POINTS, `${what} · ${s.repo ?? s.project}`, [key, scope]);
}

/** Pays for what shipped since the last look: a PR merged, a card done, a branch merged locally. */
export function noteShipped(sessions: Session[]) {
  for (const s of sessions) {
    if (s.role === "operator") continue;
    if (s.status !== "closed") seenAlive.add(s.id);
    for (const r of s.refs) {
      if (r.source !== "own") continue;
      const before = refStates.get(r.url);
      refStates.set(r.url, r.state);
      if (before !== undefined && !SHIPPED_STATES.has(before) && SHIPPED_STATES.has(r.state)) ship(s, r.label, `ref:${r.url}`);
    }
    // Only known once a session closes, and old closed sessions merged before now.
    if (s.mergedInto && s.branch && seenAlive.has(s.id)) ship(s, s.branch, `merge:${s.cwd}|${s.branch}`);
  }
}

export function pointsSummary(): Points {
  const today = new Date().toDateString();
  let total = 0;
  let todayTotal = 0;
  for (const e of entries) {
    total += e.points;
    if (new Date(e.at).toDateString() === today) todayTotal += e.points;
  }
  const recent = entries.slice(-RECENT).map(({ once: _once, ...event }) => event);
  return { total, today: todayTotal, recent };
}
