import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { sessionOrigin } from "./sessions.ts";
import type { CleanupItem, CleanupResult } from "./types.ts";

const run = promisify(execFile);

/**
 * What a session leaves behind when it ends: servers still listening from its folder, its
 * worktree and branch, its scratch folder. Nothing here forces anything. A dirty or unmerged
 * worktree is listed but not offered, and only processes tied to the session's folder show up.
 */

interface Plan {
  items: CleanupItem[];
  run: Map<string, () => Promise<void>>;
}

const inside = (dir: string, root: string) => dir === root || dir.startsWith(`${root}/`);

// "[[dd-]hh:]mm:ss" from ps etime -> seconds.
function etimeSeconds(etime: string): number {
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = (rest ?? "").split(":").map(Number).reverse();
  return Number(days) * 86400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
}

/** Every process's working directory, by pid. */
async function cwds(): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const { stdout } = await run("lsof", ["-a", "-d", "cwd", "-Fpn"], { maxBuffer: 16 * 1024 * 1024 }).catch((e) => ({ stdout: String(e.stdout ?? "") }));
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** Listening TCP ports, by pid. */
async function listeners(): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const { stdout } = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]).catch((e) => ({ stdout: String(e.stdout ?? "") }));
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const port = line.slice(line.lastIndexOf(":") + 1);
      out.set(pid, [...new Set([...(out.get(pid) ?? []), port])]);
    }
  }
  return out;
}

async function describe(pids: number[]): Promise<Map<number, { age: number; command: string }>> {
  const out = new Map<number, { age: number; command: string }>();
  if (pids.length === 0) return out;
  const { stdout } = await run("ps", ["-o", "pid=,etime=,command=", "-p", pids.join(",")]).catch((e) => ({ stdout: String(e.stdout ?? "") }));
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (m) out.set(Number(m[1]), { age: etimeSeconds(m[2] ?? ""), command: m[3] ?? "" });
  }
  return out;
}

/**
 * The session's own process tree: Claude, the shells above it in its tab or pane, and
 * everything it started. All of it goes when the session exits and its tab closes, which
 * happens before cleanup runs, so none of it counts as "in use".
 */
export async function sessionTree(claudePid: number | undefined): Promise<Set<number>> {
  const tree = new Set<number>();
  if (!claudePid) return tree;
  const { stdout } = await run("ps", ["-axo", "pid=,ppid="]).catch(() => ({ stdout: "" }));
  const parent = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    parent.set(pid, ppid);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  // Up to (not including) launchd; the folder check later drops ancestors outside the session.
  for (let p: number | undefined = claudePid; p && p > 1; p = parent.get(p)) tree.add(p);
  const stack = [claudePid];
  while (stack.length > 0) {
    for (const c of children.get(stack.pop() as number) ?? []) {
      if (!tree.has(c)) {
        tree.add(c);
        stack.push(c);
      }
    }
  }
  return tree;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run("git", ["-C", cwd, ...args], { timeout: 15_000 })).stdout.trim();
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop(pid: number) {
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) throw new Error("still running after SIGTERM");
}

/** The merged PR for this branch, if GitHub has one whose head is exactly this commit. */
async function mergedPr(cwd: string, branch: string, head: string): Promise<number | null> {
  try {
    const { stdout } = await run("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid", "--limit", "5"], {
      cwd,
      timeout: 15_000,
    });
    const prs = JSON.parse(stdout) as { number: number; headRefOid: string }[];
    return prs.find((p) => p.headRefOid === head)?.number ?? null;
  } catch {
    return null;
  }
}

async function worktreeItems(cwd: string, busy: { pid: number; command: string }[], plan: Plan) {
  let top: string;
  let common: string;
  try {
    top = await git(cwd, ["rev-parse", "--show-toplevel"]);
    common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    return; // not a git repo
  }
  const main = dirname(common);
  if (top === main) return; // the main checkout, not a worktree: nothing to remove
  const branch = await git(top, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD");
  const head = await git(top, ["rev-parse", "HEAD"]).catch(() => "");
  const dirty = (await git(top, ["status", "--porcelain"]).catch(() => "?")).split("\n").filter(Boolean).length;
  const base = (await git(main, ["rev-parse", "--verify", "--quiet", "origin/main"]).catch(() => "")) ? "origin/main" : "main";
  const ancestor = await git(main, ["merge-base", "--is-ancestor", head, base]).then(() => true, () => false);
  const pr = branch !== "HEAD" && !ancestor ? await mergedPr(main, branch, head) : null;
  const merged = ancestor || pr !== null;

  const blocked =
    dirty > 0
      ? `${dirty} uncommitted file${dirty === 1 ? "" : "s"}`
      : !merged
        ? `${branch} isn't merged into ${base}`
        : busy.length > 0
          ? `still in use by ${busy.map((b) => `${b.command.split(" ")[0]?.split("/").pop()} (${b.pid})`).join(", ")}`
          : null;
  plan.items.push({
    id: "worktree",
    kind: "worktree",
    label: `Remove worktree ${top.replace(`${dirname(main)}/`, "")}`,
    detail: blocked ?? (pr ? `PR #${pr} merged` : `merged into ${base}`),
    available: blocked === null,
    defaultOn: blocked === null,
  });
  plan.run.set("worktree", async () => {
    await git(main, ["worktree", "remove", top]);
  });

  if (branch === "HEAD") return;
  plan.items.push({
    id: "branch",
    kind: "branch",
    label: `Delete branch ${branch}`,
    detail: blocked ?? (ancestor ? `merged into ${base}` : `squash-merged as PR #${pr}, same commit`),
    available: blocked === null,
    defaultOn: blocked === null,
  });
  plan.run.set("branch", async () => {
    // -D only when GitHub says this exact commit was merged (a squash merge isn't an ancestor).
    await git(main, ["branch", ancestor ? "-d" : "-D", branch]);
  });
}

async function buildPlan(sessionId: string, claudePid: number | undefined, knownTree?: Set<number>): Promise<Plan | null> {
  const origin = await sessionOrigin(sessionId);
  if (!origin) return null;
  const { cwd, startedAt } = origin;
  const plan: Plan = { items: [], run: new Map() };
  const sessionAge = (Date.now() - startedAt) / 1000;

  const [dirs, ports, tree] = await Promise.all([cwds(), listeners(), knownTree ?? sessionTree(claudePid)]);
  const inFolder = (pid: number) => pid !== process.pid && inside(dirs.get(pid) ?? "", cwd);
  // Servers it started stay listed even though they're in its tree: background servers can
  // outlive the session. Its shells and tool processes don't block anything.
  const serverPids = [...ports.keys()].filter((pid) => inFolder(pid) && pid !== claudePid);
  const otherPids = [...dirs.keys()].filter((pid) => inFolder(pid) && !ports.has(pid) && !tree.has(pid));
  const info = await describe([...serverPids, ...otherPids]);

  for (const pid of serverPids) {
    const p = info.get(pid);
    if (!p) continue;
    // Started during the session: almost surely its own. Older ones might be yours, so unticked.
    const own = p.age <= sessionAge;
    plan.items.push({
      id: `pid:${pid}`,
      kind: "process",
      label: `Stop ${p.command.split(" ")[0]?.split("/").pop()} on port ${ports.get(pid)?.join(", ")}`,
      detail: `${p.command.slice(0, 160)}${own ? "" : " · running since before this session"}`,
      available: true,
      defaultOn: own,
    });
    plan.run.set(`pid:${pid}`, () => stop(pid));
  }

  // Shells and other processes sitting in the folder block removing it, but aren't stopped for you.
  const busy = otherPids
    .map((pid) => ({ pid, command: info.get(pid)?.command ?? "" }))
    .filter((b) => b.command && !serverPids.includes(b.pid));
  await worktreeItems(cwd, busy, plan);

  const tmpRoot = `/private/tmp/claude-${process.getuid?.() ?? ""}`;
  const scratch = join(tmpRoot, cwd.replace(/[^A-Za-z0-9]/g, "-"), sessionId);
  if (existsSync(scratch)) {
    plan.items.push({
      id: "scratch",
      kind: "scratch",
      label: "Delete its scratch folder",
      detail: scratch,
      available: true,
      defaultOn: true,
    });
    plan.run.set("scratch", () => rm(scratch, { recursive: true, force: true }));
  }
  return plan;
}

export async function cleanupPlan(sessionId: string, claudePid?: number): Promise<CleanupItem[] | null> {
  return (await buildPlan(sessionId, claudePid))?.items ?? null;
}

/**
 * Runs the picked items against a fresh plan, so anything that changed since the checklist
 * was shown (a file got dirty, a server already stopped) is judged as it is now. Servers go
 * first, then the worktree, then its branch.
 */
// `tree`: the session's process tree, taken before it exited (it can't be walked after).
export async function runCleanup(sessionId: string, picked: string[], tree: Set<number>): Promise<CleanupResult[]> {
  const plan = await buildPlan(sessionId, undefined, tree);
  if (!plan) return picked.map((id) => ({ id, ok: false, error: "transcript not found" }));
  const results: CleanupResult[] = [];
  const order = (id: string) => (id.startsWith("pid:") ? 0 : id === "worktree" ? 1 : id === "branch" ? 2 : 3);
  for (const id of [...picked].sort((a, b) => order(a) - order(b))) {
    const item = plan.items.find((i) => i.id === id);
    const action = plan.run.get(id);
    if (!item || !action) {
      results.push({ id, ok: true, error: "already gone" });
      continue;
    }
    if (!item.available) {
      results.push({ id, ok: false, error: item.detail });
      continue;
    }
    // A server left running inside the worktree would be stranded in a deleted folder.
    const stranded = plan.items.filter((i) => i.kind === "process" && !picked.includes(i.id));
    if ((id === "worktree" || id === "branch") && stranded.length > 0) {
      results.push({ id, ok: false, error: `left running: ${stranded.map((i) => i.label.replace(/^Stop /, "")).join(", ")}` });
      continue;
    }
    try {
      await action();
      results.push({ id, ok: true });
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n")[0];
      results.push({ id, ok: false, error: msg });
    }
  }
  return results;
}
