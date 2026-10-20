import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Ref, RefLinks } from "./types.ts";

const run = promisify(execFile);

const MISS_TTL_MS = 60 * 1000;

/**
 * One issue tracker. Each one finds its ids in Claude's text (and maybe the branch name) and
 * looks them up. Mention counts are keyed "<tracker>:<id>".
 */
interface Tracker {
  name: Ref["tracker"];
  /** Matches an id in free text; group 1 is the number. */
  mention: RegExp;
  /** Ids the branch name says the session is about. */
  fromBranch(branch: string): number[];
  ttl: number;
  /** Cache key for one id, or null when this session can't look it up (no GitHub repo). */
  key(id: number, repo: string | null): string | null;
  load(id: number, repo: string | null): Promise<Ref | null>;
}

// Shortcut: SHORTCUT_API_TOKEN only. Read-only GETs, never logged.
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";
const CARD_RE = /\bsc-(\d{2,6})\b/gi;

// Workflow state id -> name ("Build", "Test", "Released"), fetched once.
let statesPromise: Promise<Map<number, string>> | null = null;
function workflowStates(token: string): Promise<Map<number, string>> {
  statesPromise ??= fetch(`${SHORTCUT_API}/workflows`, { headers: { "Shortcut-Token": token } })
    .then(async (res) => {
      const flows = (await res.json()) as { states?: { id: number; name: string }[] }[];
      return new Map(flows.flatMap((f) => f.states ?? []).map((st) => [st.id, st.name]));
    })
    .catch(() => {
      statesPromise = null;
      return new Map();
    });
  return statesPromise;
}

const shortcut: Tracker = {
  name: "shortcut",
  mention: CARD_RE,
  fromBranch: (branch) => [...branch.matchAll(CARD_RE)].map((m) => Number(m[1])),
  ttl: 10 * 60 * 1000,
  key: (id) => (process.env.SHORTCUT_API_TOKEN ? String(id) : null),
  async load(id) {
    const token = process.env.SHORTCUT_API_TOKEN;
    if (!token) return null;
    const res = await fetch(`${SHORTCUT_API}/stories/${id}`, { headers: { "Shortcut-Token": token } });
    if (!res.ok) return null;
    const s = (await res.json()) as {
      name?: string;
      app_url?: string;
      completed?: boolean;
      started?: boolean;
      workflow_state_id?: number;
    };
    if (!s.name || !s.app_url) return null;
    const stateName = s.workflow_state_id ? (await workflowStates(token)).get(s.workflow_state_id) : undefined;
    return {
      tracker: "shortcut",
      kind: "card",
      label: `sc-${id}`,
      source: "own",
      mentions: 0,
      id,
      title: s.name,
      url: s.app_url,
      state: stateName?.toLowerCase() ?? (s.completed ? "done" : s.started ? "started" : "unstarted"),
    };
  },
};

// GitHub: issues and PRs share one number space, and the issues endpoint returns both.
const GH_RE = /(?:\bPR\s*#?|\bpull\/|\bissues\/|(?<![\w/])#)(\d{3,6})\b/gi;

interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  pull_request?: { merged_at: string | null };
}

function githubRef(i: GhIssue): Ref {
  const pr = !!i.pull_request;
  const state = pr && i.pull_request?.merged_at ? "merged" : pr && i.draft && i.state === "open" ? "draft" : i.state;
  return {
    tracker: "github",
    kind: pr ? "pr" : "issue",
    label: pr ? `PR #${i.number}` : `#${i.number}`,
    source: "own",
    mentions: 0,
    id: i.number,
    title: i.title,
    url: i.html_url,
    state,
  };
}

const github: Tracker = {
  name: "github",
  mention: GH_RE,
  fromBranch: () => [],
  ttl: 2 * 60 * 1000,
  key: (id, repo) => (repo ? `${repo}#${id}` : null),
  async load(id, repo) {
    if (!repo) return null;
    const { stdout } = await run("gh", ["api", `repos/${repo}/issues/${id}`], { timeout: 15_000 });
    return githubRef(JSON.parse(stdout) as GhIssue);
  },
};

const TRACKERS = [shortcut, github];

// The workspace slug in Shortcut's app URLs, fetched once.
let slugPromise: Promise<string | null> | null = null;
function shortcutSlug(): Promise<string | null> {
  const token = process.env.SHORTCUT_API_TOKEN;
  if (!token) return Promise.resolve(null);
  slugPromise ??= fetch(`${SHORTCUT_API}/member`, { headers: { "Shortcut-Token": token } })
    .then(async (res) => ((await res.json()) as { workspace2?: { url_slug?: string } }).workspace2?.url_slug ?? null)
    .then((slug) => {
      if (!slug) slugPromise = null;
      return slug;
    })
    .catch(() => {
      slugPromise = null;
      return null;
    });
  return slugPromise;
}

/** Where a bare sc-123 or #123 in this session's text points. GitHub sends issue URLs on to the PR. */
export async function refLinks(cwd: string): Promise<RefLinks> {
  const [repo, slug] = await Promise.all([githubRepo(cwd), shortcutSlug()]);
  return {
    shortcut: slug && `https://app.shortcut.com/${slug}/story/`,
    github: repo && `https://github.com/${repo}/issues/`,
  };
}

/** Tallies tracker mentions in one message into counts keyed "<tracker>:<id>". */
export function countMentions(text: string, counts: Map<string, number>) {
  for (const t of TRACKERS) {
    for (const m of text.matchAll(t.mention)) {
      const k = `${t.name}:${m[1]}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
}

function top(counts: Map<string, number>, tracker: Ref["tracker"], n: number): number[] {
  return [...counts]
    .filter(([k]) => k.startsWith(`${tracker}:`))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => Number(k.slice(tracker.length + 1)));
}

interface Cached<T> {
  at: number;
  value: T | null;
  ttl: number;
}

const cache = new Map<string, Cached<Ref>>();
const repos = new Map<string, string | null>();
const inflight = new Set<string>();

async function githubRepo(cwd: string): Promise<string | null> {
  if (repos.has(cwd)) return repos.get(cwd) ?? null;
  let repo: string | null = null;
  try {
    const { stdout } = await run("git", ["-C", cwd, "remote", "get-url", "origin"]);
    repo = stdout.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? null;
  } catch {
    // not a git repo or no origin
  }
  repos.set(cwd, repo);
  return repo;
}

function fresh<T>(c: Cached<T> | undefined): c is Cached<T> {
  return !!c && Date.now() - c.at < c.ttl;
}

// Fire-and-forget fill; the next state build picks the result up.
function fill(key: string, ttl: number, load: () => Promise<Ref | null>, onReady: () => void) {
  if (fresh(cache.get(key)) || inflight.has(key)) return;
  inflight.add(key);
  load()
    .catch(() => null)
    .then((value) => {
      cache.set(key, { at: Date.now(), value, ttl: value ? ttl : MISS_TTL_MS });
      inflight.delete(key);
      onReady();
    });
}

async function loadBranchPr(repo: string, branch: string): Promise<Ref | null> {
  const { stdout } = await run("gh", ["pr", "list", "-R", repo, "--head", branch, "--state", "all", "--limit", "1", "--json", "number"], {
    timeout: 15_000,
  });
  const [p] = JSON.parse(stdout) as { number: number }[];
  return p ? github.load(p.number, repo) : null;
}

/**
 * Cards, issues and PRs a session is about: the branch's own first, then the ones Claude
 * named most. Lookups run in the background; returns what's cached now.
 */
export async function refsFor(
  cwd: string,
  branch: string | null,
  counts: Map<string, number>,
  onReady: () => void,
): Promise<Ref[]> {
  const repo = await githubRepo(cwd);
  const out: Ref[] = [];
  const seen = new Set<string>();
  const add = (r: Ref | null | undefined, source: Ref["source"]) => {
    const k = r && `${r.tracker}:${r.id}`;
    if (!r || !k || seen.has(k)) return;
    seen.add(k);
    out.push({ ...r, source, mentions: counts.get(k) ?? 0 });
  };

  // The branch's PR is looked up by head ref, not by a number in its name.
  if (repo && branch && branch !== "main" && branch !== "master" && branch !== "HEAD") {
    const key = `branch:${repo}#${branch}`;
    fill(key, github.ttl, () => loadBranchPr(repo, branch), onReady);
    add(cache.get(key)?.value, "own");
  }
  for (const t of TRACKERS) {
    const own = new Set(t.fromBranch(branch ?? ""));
    for (const id of new Set([...own, ...top(counts, t.name, 4)])) {
      const key = t.key(id, repo);
      if (!key) continue;
      const k = `${t.name}:${key}`;
      fill(k, t.ttl, () => t.load(id, repo), onReady);
      add(cache.get(k)?.value, own.has(id) ? "own" : "mention");
    }
  }
  // The session's own card and PR lead; mentions follow.
  return out.sort((a, b) => Number(a.source === "mention") - Number(b.source === "mention"));
}
