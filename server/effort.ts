import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EFFORT_RULES, haiku } from "./next-action.ts";
import type { Effort } from "./types.ts";

const run = promisify(execFile);

const WORDS_PER_MIN = 200;
const DIFF_LINES_PER_MIN = 10;
const MAX_REVIEW_MIN = 60;
const DIFF_TTL_MS = 60 * 1000;

/** Minutes to read text at an even pace, at least 1. */
export function readingMinutes(text: string): number {
  return Math.max(1, Math.round(text.split(/\s+/).filter(Boolean).length / WORDS_PER_MIN));
}

// cwd -> lines changed against the main branch, committed or not.
const diffs = new Map<string, { at: number; lines: number | null }>();
const diffsLoading = new Set<string>();

async function loadDiffLines(cwd: string): Promise<number | null> {
  for (const main of ["main", "master"]) {
    let base: string;
    try {
      base = (await run("git", ["-C", cwd, "merge-base", main, "HEAD"])).stdout.trim();
    } catch {
      continue;
    }
    const { stdout } = await run("git", ["-C", cwd, "diff", "--shortstat", base]);
    const added = Number(stdout.match(/(\d+) insertion/)?.[1] ?? 0);
    const removed = Number(stdout.match(/(\d+) deletion/)?.[1] ?? 0);
    return added + removed;
  }
  return null;
}

/** Cached lines changed in the session's folder; starts a lookup when stale. */
function diffLines(cwd: string, onReady: () => void): number | null {
  const hit = diffs.get(cwd);
  if ((!hit || Date.now() - hit.at > DIFF_TTL_MS) && !diffsLoading.has(cwd)) {
    diffsLoading.add(cwd);
    loadDiffLines(cwd)
      .catch(() => null)
      .then((lines) => {
        diffs.set(cwd, { at: Date.now(), lines });
        diffsLoading.delete(cwd);
        if (lines !== hit?.lines) onReady();
      });
  }
  return hit?.lines ?? null;
}

/**
 * The model's guess, never under the time it takes to read the message, or to review the diff
 * when that's the ask. The model weighs the decision; the floors keep it honest about length.
 */
export function messageEffort(
  ai: { minutes: number; why: string; reviewsDiff: boolean },
  text: string,
  cwd: string,
  onReady: () => void,
): Effort {
  let effort: Effort = { minutes: ai.minutes, why: ai.why };
  const read = readingMinutes(text);
  if (read > effort.minutes) effort = { minutes: read, why: `read ${text.split(/\s+/).length}-word message` };
  if (ai.reviewsDiff) {
    const lines = diffLines(cwd, onReady);
    const review = lines ? Math.min(MAX_REVIEW_MIN, Math.ceil(lines / DIFF_LINES_PER_MIN)) : 0;
    if (lines && review > effort.minutes) effort = { minutes: review, why: `review ${lines}-line diff` };
  }
  return effort;
}

const APPROVAL_SCHEMA = JSON.stringify({
  type: "object",
  properties: { minutes: { type: "number" }, why: { type: "string" } },
  required: ["minutes", "why"],
  additionalProperties: false,
});

const APPROVAL_PROMPT = `A coding agent is waiting on its user to approve a tool call, or to answer the questions in it (AskUserQuestion). Estimate the user's effort.
${EFFORT_RULES}
A routine read-only call (reading a file, listing, searching, a git status) is 0 with why "routine".

Agent's last message before the call (may be empty):
<message>
{message}
</message>

Tool: {tool}
What it's for: {detail}
<input>
{input}
</input>`;

const approvals = new Map<string, Effort | null>();
const approvalsLoading = new Set<string>();
const MAX_CONCURRENT = 2;

/** Cached effort for a pending approval or question. Undefined while it's being worked out. */
export function approvalEffort(
  p: { id: string; toolName: string; detail: string | null; toolInput: unknown },
  lastMessage: string | undefined,
  onReady: () => void,
): Effort | null | undefined {
  if (approvals.has(p.id)) return approvals.get(p.id);
  if (approvalsLoading.has(p.id) || approvalsLoading.size >= MAX_CONCURRENT) return undefined;
  approvalsLoading.add(p.id);
  const input = JSON.stringify(p.toolInput, null, 1) ?? "";
  // Function replacers, so a "$&" in the text stays literal.
  const prompt = APPROVAL_PROMPT.replace("{message}", () => (lastMessage ?? "").slice(-3000))
    .replace("{tool}", () => p.toolName)
    .replace("{detail}", () => p.detail ?? "(none)")
    .replace("{input}", () => input.slice(0, 6000));
  haiku<Effort>(prompt, APPROVAL_SCHEMA)
    .then((out) =>
      out ? { minutes: Math.max(0, Math.round(Number(out.minutes) || 0)), why: out.why?.trim() || "" } : null,
    )
    .catch(() => null)
    .then((effort) => {
      approvals.set(p.id, effort);
      approvalsLoading.delete(p.id);
      onReady();
    });
  return undefined;
}

/** Forget approvals that were decided or expired. */
export function keepApprovalEfforts(ids: Set<string>) {
  for (const id of approvals.keys()) if (!ids.has(id)) approvals.delete(id);
}
