import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Ref } from "./types.ts";

const run = promisify(execFile);

// Shortcut token: env first, else the aero repo's gitignored .mcp.json. Read-only GETs, never logged.
const MCP_JSON = process.env.DECK_SHORTCUT_MCP_JSON ?? join(homedir(), "code", "tailwind", "aero", ".mcp.json");
const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";
const CARD_TTL_MS = 10 * 60 * 1000;
const PR_TTL_MS = 2 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;

const CARD_RE = /\bsc-(\d{2,6})\b/gi;
const PR_RE = /(?:\bPR\s*#?|\bpull\/|(?<![\w/])#)(\d{3,6})\b/gi;

/** Tallies card and PR mentions in one message into counts keyed "card:N" / "pr:N". */
export function countMentions(text: string, counts: Map<string, number>) {
  for (const m of text.matchAll(CARD_RE)) counts.set(`card:${m[1]}`, (counts.get(`card:${m[1]}`) ?? 0) + 1);
  for (const m of text.matchAll(PR_RE)) counts.set(`pr:${m[1]}`, (counts.get(`pr:${m[1]}`) ?? 0) + 1);
}

function top(counts: Map<string, number>, kind: "card" | "pr", n: number): number[] {
  return [...counts]
    .filter(([k]) => k.startsWith(`${kind}:`))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => Number(k.slice(kind.length + 1)));
}

interface Cached<T> {
  at: number;
  value: T | null;
  ttl: number;
}

const cards = new Map<number, Cached<Ref>>();
const prs = new Map<string, Cached<Ref>>();
const branchPrs = new Map<string, Cached<Ref>>();
const repos = new Map<string, string | null>();
const inflight = new Set<string>();

let tokenPromise: Promise<string | null> | null = null;
function shortcutToken(): Promise<string | null> {
  tokenPromise ??= (async () => {
    if (process.env.SHORTCUT_API_TOKEN) return process.env.SHORTCUT_API_TOKEN;
    try {
      const cfg = JSON.parse(await readFile(MCP_JSON, "utf8")) as {
        mcpServers?: { shortcut?: { env?: { SHORTCUT_API_TOKEN?: string } } };
      };
      return cfg.mcpServers?.shortcut?.env?.SHORTCUT_API_TOKEN ?? null;
    } catch {
      return null;
    }
  })();
  return tokenPromise;
}

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
function fill<K>(map: Map<K, Cached<Ref>>, key: K, ttl: number, load: () => Promise<Ref | null>, onReady: () => void) {
  const flight = `${String(key)}`;
  if (fresh(map.get(key)) || inflight.has(flight)) return;
  inflight.add(flight);
  load()
    .catch(() => null)
    .then((value) => {
      map.set(key, { at: Date.now(), value, ttl: value ? ttl : MISS_TTL_MS });
      inflight.delete(flight);
      onReady();
    });
}

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

async function loadCard(id: number): Promise<Ref | null> {
  const token = await shortcutToken();
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
  if (!s.name) return null;
  const stateName = s.workflow_state_id ? (await workflowStates(token)).get(s.workflow_state_id) : undefined;
  return {
    kind: "card",
    source: "own",
    mentions: 0,
    id,
    title: s.name,
    url: s.app_url ?? `https://app.shortcut.com/tailwnd/story/${id}`,
    state: stateName?.toLowerCase() ?? (s.completed ? "done" : s.started ? "started" : "unstarted"),
  };
}

interface GhPr {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
}

function prRef(p: GhPr): Ref {
  return { kind: "pr", source: "own", mentions: 0, id: p.number, title: p.title, url: p.url, state: p.isDraft && p.state === "OPEN" ? "draft" : p.state.toLowerCase() };
}

async function loadPr(repo: string, n: number): Promise<Ref | null> {
  const { stdout } = await run("gh", ["pr", "view", String(n), "-R", repo, "--json", "number,title,url,state,isDraft"], {
    timeout: 15_000,
  });
  return prRef(JSON.parse(stdout) as GhPr);
}

async function loadBranchPr(repo: string, branch: string): Promise<Ref | null> {
  const { stdout } = await run(
    "gh",
    ["pr", "list", "-R", repo, "--head", branch, "--state", "all", "--limit", "1", "--json", "number,title,url,state,isDraft"],
    { timeout: 15_000 },
  );
  const [p] = JSON.parse(stdout) as GhPr[];
  return p ? prRef(p) : null;
}

/**
 * Cards and PRs a session is about: the branch's card and PR first, then the ones Claude
 * named most. Lookups run in the background; returns what's cached now.
 */
export async function refsFor(
  cwd: string,
  branch: string | null,
  counts: Map<string, number>,
  onReady: () => void,
): Promise<Ref[]> {
  const repo = await githubRepo(cwd);
  const ownCards = new Set([...(branch ?? "").matchAll(CARD_RE)].map((m) => Number(m[1])));
  const cardIds = new Set<number>([...ownCards, ...top(counts, "card", 4)]);
  const prIds = repo ? top(counts, "pr", 4) : [];

  const out: Ref[] = [];
  const seen = new Set<string>();
  const add = (r: Ref | null | undefined, source: Ref["source"]) => {
    if (!r || seen.has(`${r.kind}${r.id}`)) return;
    seen.add(`${r.kind}${r.id}`);
    out.push({ ...r, source, mentions: counts.get(`${r.kind}:${r.id}`) ?? 0 });
  };

  for (const id of [...cardIds].slice(0, 4)) {
    fill(cards, id, CARD_TTL_MS, () => loadCard(id), onReady);
    add(cards.get(id)?.value, ownCards.has(id) ? "own" : "mention");
  }
  if (repo && branch && branch !== "main" && branch !== "master" && branch !== "HEAD") {
    const key = `${repo}#${branch}`;
    fill(branchPrs, key, PR_TTL_MS, () => loadBranchPr(repo, branch), onReady);
    add(branchPrs.get(key)?.value, "own");
  }
  if (repo) {
    for (const n of prIds) {
      const key = `${repo}#${n}`;
      fill(prs, key, PR_TTL_MS, () => loadPr(repo, n), onReady);
      add(prs.get(key)?.value, "mention");
    }
  }
  // The session's own card and PR lead; mentions follow.
  return out.sort((a, b) => Number(a.source === "mention") - Number(b.source === "mention"));
}
