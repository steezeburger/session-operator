import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pause } from "./types.ts";

// Paused sessions are kept on disk next to the roles file, so a restart keeps them and sop
// and the deck see the same thing.
const PAUSES_FILE = join(tmpdir(), "session-operator-pauses.json");
const pauses = new Map<string, Pause>(
  (() => {
    try {
      return Object.entries(JSON.parse(readFileSync(PAUSES_FILE, "utf8")) as Record<string, Pause>);
    } catch {
      return [];
    }
  })(),
);

function save() {
  void writeFile(PAUSES_FILE, JSON.stringify(Object.fromEntries(pauses))).catch(() => {});
}

/** The session's pause, unless it has run out (then it's forgotten). */
export function pauseOf(sessionId: string): Pause | null {
  const p = pauses.get(sessionId);
  if (!p) return null;
  if (p.until && Date.parse(p.until) <= Date.now()) {
    unpause(sessionId);
    return null;
  }
  return p;
}

export function pause(sessionId: string, until: Date | null): Pause {
  const p = { until: until?.toISOString() ?? null, since: new Date().toISOString() };
  pauses.set(sessionId, p);
  save();
  return p;
}

/** True if it was paused. */
export function unpause(sessionId: string): boolean {
  if (!pauses.delete(sessionId)) return false;
  save();
  return true;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DEFAULT_HOUR = 9;

/**
 * When a pause written as text ends. Empty means until you unpause (null). Takes "30m", "2h",
 * "1d", "tomorrow", "workday" (the next Mon-Fri), a weekday ("mon", "friday"), any of those
 * with a time ("tomorrow 9am", "mon 14:30"), a time alone ("6pm", the next one), or an ISO date.
 * A day with no time means 9am. Throws on anything else.
 */
export function parseUntil(text: string, now = new Date()): Date | null {
  const t = text.trim().toLowerCase().replace(/^until\s+/, "");
  if (!t) return null;

  const dur = t.match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|days?)$/);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2]?.[0] === "m" ? 60_000 : dur[2]?.[0] === "h" ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + n * unit);
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const at = new Date(text.trim());
    if (Number.isNaN(at.getTime())) throw new Error(`can't read "${text}" as a date`);
    return at;
  }

  let day: string | null = null;
  let time: string | null = null;
  for (const word of t.replace(/^next\s+/, "").split(/\s+/)) {
    if (/^\d/.test(word) || word === "am" || word === "pm") time = time ? `${time}${word}` : word;
    else if (day) throw new Error(`can't read "${text}" - try 2h, tomorrow, mon 9am or 6pm`);
    else day = word;
  }

  let hour = DEFAULT_HOUR;
  let minute = 0;
  if (time) {
    const m = time.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
    if (!m) throw new Error(`can't read "${time}" as a time`);
    hour = Number(m[1]);
    minute = Number(m[2] ?? 0);
    if (m[3] === "pm" && hour < 12) hour += 12;
    if (m[3] === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new Error(`can't read "${time}" as a time`);
  }

  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (!day || day === "today") {
    if (at <= now) at.setDate(at.getDate() + 1);
    return at;
  }
  if (day === "tomorrow") {
    at.setDate(at.getDate() + 1);
    return at;
  }
  if (day === "workday") {
    do at.setDate(at.getDate() + 1);
    while (at.getDay() === 0 || at.getDay() === 6);
    return at;
  }
  // "mon", "tues", "thursday": any start of a day's name, three letters or more.
  const want = day.length >= 3 ? DAYS.findIndex((d) => d.startsWith(day)) : -1;
  if (want < 0) throw new Error(`can't read "${text}" - try 2h, tomorrow, workday, mon 9am or 6pm`);
  // A weekday is always a future one: "mon" on a Monday means next Monday.
  at.setDate(at.getDate() + ((want - at.getDay() + 7) % 7 || 7));
  return at;
}
