import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const merges = new Map<string, Cached<string>>();
const repos = new Map<string, string | null>();
const repoDirs = new Map<string, Promise<string | null>>();
const inflight = new Set<string>();

async function commonDir(dir: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return dirname(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * The main checkout behind a session's folder. A session that removed its own worktree leaves
 * a cwd that's gone, so look for the repo it lived in: the nearest folder still there
 * (repo/.worktrees/x), then a sibling named by dropping the worktree's suffix (repo-x).
 */
function repoDir(cwd: string): Promise<string | null> {
  let dir = repoDirs.get(cwd);
  if (!dir) {
    dir = (async () => {
      if (existsSync(cwd)) return commonDir(cwd);
      let up = dirname(cwd);
      while (!existsSync(up)) up = dirname(up);
      const parts = basename(cwd).split("-");
      for (let n = parts.length - 1; n > 0; n--) {
        const sibling = join(dirname(cwd), parts.slice(0, n).join("-"));
        if (existsSync(sibling)) return commonDir(sibling);
      }
      return commonDir(up);
    })();
    repoDirs.set(cwd, dir);
  }
  return dir;
}

/** The name of the main checkout behind `cwd`: the same for every worktree of a repo. */
export async function repoName(cwd: string): Promise<string | null> {
  const dir = await repoDir(cwd);
  return dir ? basename(dir) : null;
}

async function githubRepo(cwd: string): Promise<string | null> {
  if (repos.has(cwd)) return repos.get(cwd) ?? null;
  let repo: string | null = null;
  const dir = await repoDir(cwd);
  try {
    if (dir) {
      const { stdout } = await run("git", ["-C", dir, "remote", "get-url", "origin"]);
      repo = stdout.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? null;
    }
  } catch {
    // no origin
  }
  repos.set(cwd, repo);
  return repo;
}

function fresh<T>(c: Cached<T> | undefined): c is Cached<T> {
  return !!c && Date.now() - c.at < c.ttl;
}

// Fire-and-forget fill; the next state build picks the result up.
function fill<T>(store: Map<string, Cached<T>>, key: string, ttl: number, load: () => Promise<T | null>, onReady: () => void) {
  if (fresh(store.get(key)) || inflight.has(key)) return;
  inflight.add(key);
  load()
    .catch(() => null)
    .then((value) => {
      store.set(key, { at: Date.now(), value, ttl: value ? ttl : MISS_TTL_MS });
      inflight.delete(key);
      onReady();
    });
}

async function loadLocalMerge(dir: string, branch: string): Promise<string | null> {
  for (const main of ["main", "master"]) {
    try {
      await run("git", ["-C", dir, "rev-parse", "--verify", "--quiet", main]);
    } catch {
      continue;
    }
    const { stdout } = await run("git", [
      "-C", dir, "log", main, "--first-parent", "--merges", "--fixed-strings",
      "--grep", `Merge branch '${branch}'`, "--format=%h", "-1",
    ]);
    return stdout.trim() ? main : null;
  }
  return null;
}

/**
 * The main branch, when this session's branch went into it as a local merge commit
 * ("Merge branch 'x'"). Works after the branch is deleted, which a cleaned-up session does.
 */
export async function mergedInto(cwd: string, branch: string | null, onReady: () => void): Promise<string | null> {
  if (!branch || branch === "main" || branch === "master") return null;
  const dir = await repoDir(cwd);
  if (!dir) return null;
  const key = `merge:${dir}#${branch}`;
  fill(merges, key, 2 * 60 * 1000, () => loadLocalMerge(dir, branch), onReady);
  return merges.get(key)?.value ?? null;
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
    fill(cache, key, github.ttl, () => loadBranchPr(repo, branch), onReady);
    add(cache.get(key)?.value, "own");
  }
  for (const t of TRACKERS) {
    const own = new Set(t.fromBranch(branch ?? ""));
    for (const id of new Set([...own, ...top(counts, t.name, 4)])) {
      const key = t.key(id, repo);
      if (!key) continue;
      const k = `${t.name}:${key}`;
      fill(cache, k, t.ttl, () => t.load(id, repo), onReady);
      add(cache.get(k)?.value, own.has(id) ? "own" : "mention");
    }
  }
  // The session's own card and PR lead; mentions follow.
  return out.sort((a, b) => Number(a.source === "mention") - Number(b.source === "mention"));
}
