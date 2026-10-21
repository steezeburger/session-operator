import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface NextAction {
  action: string;
  url: string | null;
  say: string | null;
  blockedOn: string | null;
  /** The message asks the user to do, answer or decide something. */
  needsUser: boolean;
  /** What the session is working on, in a few words, for the list. */
  topic: string | null;
}

const SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    action: { type: "string" },
    url: { type: ["string", "null"] },
    say: { type: ["string", "null"] },
    blockedOn: { type: ["string", "null"] },
    needsUser: { type: "boolean" },
    topic: { type: ["string", "null"] },
  },
  required: ["action", "url", "say", "blockedOn", "needsUser", "topic"],
  additionalProperties: false,
});

const PROMPT = `Below is the last message a coding agent sent its user. Say the ONE specific thing the user must do next, as a short imperative (max 12 words) naming the concrete target, e.g. "Merge PR #5793", "Log in on the staging site", "Pick option 1-4 for the Matrix restyle", "Run /push in the sc-7209 worktree". Never say generic things like "read the message", "reply", or "review the result". If nothing is asked of the user, say what the agent finished and that the session can be closed, e.g. "Nothing needed - PR #5672 merged, close it".
url: the link the user should open for this step, chosen ONLY from the candidate links below, else null.
say: exact text the user should type back to the agent, if the message asks for specific text, else null.
blockedOn: if nothing can usefully happen until something outside the user finishes (a CI run, a deploy, a code review, a migration, a scheduled job), name it in a few words, e.g. "prod deploy of #5801", "CI on PR #5798". Null if the user can act right now, and null when the agent itself is still doing the work (fixing, editing, running tests) - only things outside both of them count.
needsUser: true if the message asks the user to do, test, run, answer or decide anything, false if nothing is asked of them.
topic: what the agent is working on, as a 2-5 word lowercase noun phrase naming the thing, e.g. "chat feed colors", "pr #5801 review fixes", "favicon". Not what it did or what's next, the subject. Null if unclear.

Candidate links:
{links}

<message>
{message}
</message>`;

const URL_RE = /https?:\/\/[^\s)`'"<>\]]+/g;
const PR_RE = /\b(?:PR|pull request|pr (?:checks|view|merge))\s*#?(\d{2,6})\b/gi;

// The model never runs in a project dir, so it can't pick up CLAUDE.md or show up in the operator.
const WORK_DIR = mkdtempSync(join(tmpdir(), "session-operator-"));
const MAX_CONCURRENT = 2;

const cache = new Map<string, { hash: string; result: NextAction | null }>();
const inflight = new Set<string>();
const remotes = new Map<string, string | null>();

async function githubRepo(cwd: string): Promise<string | null> {
  if (remotes.has(cwd)) return remotes.get(cwd) ?? null;
  let repo: string | null = null;
  try {
    const { stdout } = await run("git", ["-C", cwd, "remote", "get-url", "origin"]);
    repo = stdout.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    // not a git repo or no origin
  }
  remotes.set(cwd, repo);
  return repo;
}

async function candidateLinks(text: string, cwd: string): Promise<string[]> {
  const links = new Set(text.match(URL_RE) ?? []);
  const repo = await githubRepo(cwd);
  if (repo) for (const m of text.matchAll(PR_RE)) links.add(`https://github.com/${repo}/pull/${m[1]}`);
  return [...links];
}

async function infer(text: string, cwd: string): Promise<NextAction | null> {
  const links = await candidateLinks(text, cwd);
  const prompt = PROMPT.replace("{links}", links.join("\n") || "(none)").replace("{message}", text);
  const child = run(
    "claude",
    [
      "-p",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--strict-mcp-config",
      "--tools",
      "",
      "--output-format",
      "json",
      "--json-schema",
      SCHEMA,
    ],
    { cwd: WORK_DIR, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  child.child.stdin?.end(prompt);
  const { stdout } = await child;
  const out = (JSON.parse(stdout) as { structured_output?: NextAction }).structured_output;
  if (!out?.action) return null;
  return {
    action: out.action,
    // Only links we found ourselves; the model picks, it doesn't invent.
    url: out.url && links.includes(out.url) ? out.url : null,
    say: out.say || null,
    blockedOn: out.blockedOn || null,
    needsUser: out.needsUser === true,
    topic: out.topic?.trim() || null,
  };
}

/**
 * Cached next action for a session's last message. Returns undefined while it's being
 * worked out (and starts that work), null if inference failed.
 */
export function nextActionFor(
  sessionId: string,
  cwd: string,
  text: string,
  onReady: () => void,
): NextAction | null | undefined {
  const hash = createHash("sha1").update(text).digest("hex");
  const hit = cache.get(sessionId);
  if (hit?.hash === hash) return hit.result;
  if (inflight.has(sessionId) || inflight.size >= MAX_CONCURRENT) return undefined;

  inflight.add(sessionId);
  infer(text, cwd)
    .catch(() => null)
    .then((result) => {
      cache.set(sessionId, { hash, result });
      inflight.delete(sessionId);
      onReady();
    });
  return undefined;
}
