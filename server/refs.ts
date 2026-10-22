import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { githubId, labelFor, parseMentions, refKey, resolveId, type TrackerContext, type TrackerName } from "./mentions.ts";
import type { Ref } from "./types.ts";

const run = promisify(execFile);

const MISS_TTL_MS = 60 * 1000;

/** A ref as a tracker loads it. Its label, source and mention count depend on the session. */
type Loaded = Omit<Ref, "label" | "source" | "mentions">;

/**
 * One issue tracker: the ids a branch name says a session is about, and how to look one up.
 * How its ids are written in text lives in mentions.ts, which the web app shares.
 */
interface Tracker {
  name: TrackerName;
  /** Ids the branch name says the session is about. GitHub's are relative ("#123"). */
  fromBranch(branch: string): string[];
  ttl: number;
  /** Whether lookups can work on this machine at all. */
  ready(): boolean;
  /** Looks up one resolved id. */
  load(id: string): Promise<Loaded | null>;
}

// Shortcut: SHORTCUT_API_TOKEN only. Read-only GETs, never logged.
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";

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
  fromBranch: (branch) => [...branch.matchAll(/\bsc-(\d{2,6})\b/gi)].map((m) => m[1]!),
  ttl: 10 * 60 * 1000,
  ready: () => !!process.env.SHORTCUT_API_TOKEN,
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
      id,
      key: refKey("shortcut", id),
      title: s.name,
      url: s.app_url,
      state: stateName?.toLowerCase() ?? (s.completed ? "done" : s.started ? "started" : "unstarted"),
    };
  },
};

// GitHub: issues and PRs share one number space, and the issues endpoint returns both.
interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  state_reason?: string | null;
  draft?: boolean;
  pull_request?: { merged_at: string | null };
}

// A branch names its issue by leading with the number: "123-fix-login" (what `gh issue develop`
// makes), also "issue-123-...", "gh-123/..." or "me/feat/123-...". A leading date
// ("2026-10-notes") isn't an issue.
const ISSUE_BRANCH_RE = /^(?:[\w.-]+\/)*(?:issue-|gh-)?(?!(?:19|20)\d\d-\d\d(?:\D|$))(\d{1,6})(?:[-_/]|$)/i;

// Set when the token lacks read:project, so issues skip the Project lookup for a while.
let noProjectScopeUntil = 0;

/**
 * The issue's Status column on a GitHub Project ("Todo", "In Progress", "Done"), if it's on
 * one; on several, the most recently changed. Needs the read:project scope
 * (`gh auth refresh -s read:project`); without it, null.
 */
async function projectStatus(repo: string, n: number): Promise<string | null> {
  if (Date.now() < noProjectScopeUntil) return null;
  const [owner, name] = repo.split("/");
  try {
    const { stdout } = await run(
      "gh",
      [
        "api", "graphql",
        "-f", "query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:10){nodes{fieldValueByName(name:\"Status\"){... on ProjectV2ItemFieldSingleSelectValue{name updatedAt}}}}}}}",
        "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${n}`,
      ],
      { timeout: 15_000 },
    );
    type Status = { name?: string; updatedAt?: string } | null;
    const nodes = (JSON.parse(stdout) as { data?: { repository?: { issue?: { projectItems?: { nodes?: { fieldValueByName?: Status }[] } } } } })
      .data?.repository?.issue?.projectItems?.nodes ?? [];
    const statuses = nodes.map((x) => x.fieldValueByName).filter((x): x is { name: string; updatedAt?: string } => !!x?.name);
    statuses.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return statuses[0]?.name ?? null;
  } catch (e) {
    const out = `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`;
    if (/INSUFFICIENT_SCOPES|read:project/.test(out)) noProjectScopeUntil = Date.now() + 10 * 60 * 1000;
    return null;
  }
}

function githubRef(repo: string, i: GhIssue, status: string | null = null): Loaded {
  const pr = !!i.pull_request;
  // An issue on a Project shows its Status column; otherwise closed-as-completed reads as done.
  // Closed as not planned stays closed, whatever column a Project's "Item closed" workflow
  // moved it to, so it never reads as shipped.
  const issueState =
    i.state_reason === "not_planned"
      ? "closed"
      : (status?.toLowerCase() ?? (i.state === "closed" && i.state_reason === "completed" ? "done" : i.state));
  const state = pr ? (i.pull_request?.merged_at ? "merged" : i.draft && i.state === "open" ? "draft" : i.state) : issueState;
  const id = `${repo}#${i.number}`;
  return {
    tracker: "github",
    kind: pr ? "pr" : "issue",
    id,
    key: refKey("github", id),
    title: i.title,
    url: i.html_url,
    state,
  };
}

const github: Tracker = {
  name: "github",
  fromBranch: (branch) => {
    const m = branch.match(ISSUE_BRANCH_RE);
    return m ? [`#${m[1]}`] : [];
  },
  ttl: 2 * 60 * 1000,
  ready: () => true,
  async load(id) {
    const g = githubId(id);
    if (!g) return null;
    const { stdout } = await run("gh", ["api", `repos/${g.repo}/issues/${g.n}`], { timeout: 15_000 });
    const issue = JSON.parse(stdout) as GhIssue;
    return githubRef(g.repo, issue, issue.pull_request ? null : await projectStatus(g.repo, g.n));
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

/** The session's repo and Shortcut workspace, for resolving and linking mentions. */
export async function trackerContext(cwd: string): Promise<TrackerContext> {
  const [repo, slug] = await Promise.all([githubRepo(cwd), shortcutSlug()]);
  return { githubRepo: repo, shortcutSlug: slug };
}

/** Tallies tracker mentions in one message into counts keyed "<tracker>:<id>", ids as written. */
export function countMentions(text: string, counts: Map<string, number>) {
  for (const m of parseMentions(text)) {
    const k = `${m.tracker}:${m.id}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
}

interface Cached<T> {
  at: number;
  value: T | null;
  ttl: number;
}

const cache = new Map<string, Cached<Loaded>>();
const merges = new Map<string, Cached<string>>();
const branches = new Map<string, Cached<BranchPr>>();
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

/** The folder name of the main checkout behind `cwd`: the same for every worktree of a repo. */
export async function checkoutName(cwd: string): Promise<string | null> {
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

// The branch's PR, looked up by head ref, and the issues it says it closes ("Closes #123"),
// which may live in another repo.
interface BranchPr {
  pr: string;
  closes: string[];
}

async function loadBranchPr(repo: string, branch: string): Promise<BranchPr | null> {
  const { stdout } = await run(
    "gh",
    ["pr", "list", "-R", repo, "--head", branch, "--state", "all", "--limit", "1", "--json", "number,closingIssuesReferences"],
    { timeout: 15_000 },
  );
  type Closing = { number: number; repository?: { name: string; owner: { login: string } } };
  const [p] = JSON.parse(stdout) as { number: number; closingIssuesReferences?: Closing[] }[];
  if (!p) return null;
  return {
    pr: `${repo}#${p.number}`.toLowerCase(),
    closes: (p.closingIssuesReferences ?? []).map((x) =>
      (x.repository ? `${x.repository.owner.login}/${x.repository.name}#${x.number}` : `${repo}#${x.number}`).toLowerCase(),
    ),
  };
}

/**
 * Cards, issues and PRs a session is about: its branch's PR and the issues that PR closes,
 * whatever the branch name says, then the ones Claude named most. Lookups run in the
 * background; returns what's cached now.
 */
export async function refsFor(
  cwd: string,
  branch: string | null,
  counts: Map<string, number>,
  onReady: () => void,
): Promise<Ref[]> {
  const repo = await githubRepo(cwd);

  // "#123" and "owner/repo#123" are the same item once pinned to this session's repo.
  const mentions = new Map<string, number>();
  for (const [k, n] of counts) {
    const at = k.indexOf(":");
    const tracker = k.slice(0, at) as TrackerName;
    const id = resolveId(tracker, k.slice(at + 1), repo);
    if (id) mentions.set(refKey(tracker, id), (mentions.get(refKey(tracker, id)) ?? 0) + n);
  }

  const wanted: { t: Tracker; id: string; source: Ref["source"] }[] = [];
  const seen = new Set<string>();
  const want = (t: Tracker, id: string | null, source: Ref["source"]) => {
    if (!id || seen.has(refKey(t.name, id))) return;
    seen.add(refKey(t.name, id));
    wanted.push({ t, id, source });
  };

  if (repo && branch && branch !== "main" && branch !== "master" && branch !== "HEAD") {
    const key = `branch:${repo}#${branch}`;
    fill(branches, key, github.ttl, () => loadBranchPr(repo, branch), onReady);
    const b = branches.get(key)?.value;
    want(github, b?.pr ?? null, "own");
    for (const id of b?.closes ?? []) want(github, id, "own");
  }
  for (const t of TRACKERS) {
    for (const id of t.fromBranch(branch ?? "")) want(t, resolveId(t.name, id, repo), "own");
  }
  for (const t of TRACKERS) {
    const top = [...mentions].filter(([k]) => k.startsWith(`${t.name}:`)).sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [k] of top) want(t, k.slice(t.name.length + 1), "mention");
  }

  // The session's own card, issue and PR lead; mentions follow.
  const out: Ref[] = [];
  for (const { t, id, source } of wanted) {
    if (!t.ready()) continue;
    const key = refKey(t.name, id);
    fill(cache, key, t.ttl, () => t.load(id), onReady);
    const r = cache.get(key)?.value;
    if (r) out.push({ ...r, source, label: labelFor(r.tracker, r.id, r.kind, repo), mentions: mentions.get(key) ?? 0 });
  }
  return out;
}
