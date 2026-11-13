// How each tracker's items are written in text, and where they live. Shared by the server
// (counting what a session talks about) and the web app (linking it), so both read text the
// same way. No node imports here, it runs in the browser too.
//
// An id is tracker-local: a Shortcut card is "123", a GitHub item is "owner/repo#123". Text
// often leaves the repo out ("#123", "PR #123"); those come back relative ("#123") and
// resolveId pins them to the session's repo. A ref's key is "<tracker>:<id>".

export type TrackerName = "shortcut" | "github";

/** What a session needs to resolve and link ids: its GitHub repo, the Shortcut workspace. */
export interface TrackerContext {
  /** "owner/repo" from the session's origin remote. */
  githubRepo: string | null;
  /** The workspace in Shortcut's app URLs. Only known with SHORTCUT_API_TOKEN. */
  shortcutSlug: string | null;
}

export interface Mention {
  index: number;
  text: string;
  tracker: TrackerName;
  /** "123" (Shortcut), "owner/repo#123", or "#123" (a GitHub item in the session's repo). */
  id: string;
  /** Says what it is, so it's safe to link without looking it up. A bare #123 doesn't. */
  explicit: boolean;
}

interface Syntax {
  tracker: TrackerName;
  re: RegExp;
  id(m: RegExpMatchArray): string;
  explicit: boolean;
}

const SYNTAX: Syntax[] = [
  { tracker: "shortcut", re: /\bapp\.shortcut\.com\/[\w-]+\/story\/(\d+)/gi, id: (m) => m[1]!, explicit: true },
  { tracker: "shortcut", re: /\bsc-(\d{2,6})\b/gi, id: (m) => m[1]!, explicit: true },
  {
    tracker: "github",
    re: /\bgithub\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/gi,
    id: (m) => `${m[1]}#${m[2]}`,
    explicit: true,
  },
  { tracker: "github", re: /(?<![\w/.-])([\w.-]+\/[\w.-]+)#(\d+)\b/g, id: (m) => `${m[1]}#${m[2]}`, explicit: true },
  { tracker: "github", re: /\bPR\s*#?(\d{1,6})\b/gi, id: (m) => `#${m[1]}`, explicit: true },
  // Short bare numbers are usually list items or counts, so these start at 3 digits.
  { tracker: "github", re: /(?<![\w/#])#(\d{3,6})\b/g, id: (m) => `#${m[1]}`, explicit: false },
];

/** Every tracker item named in the text, in order. Overlaps go to the earlier, longer match. */
export function parseMentions(text: string): Mention[] {
  const all: Mention[] = [];
  for (const s of SYNTAX) {
    for (const m of text.matchAll(s.re)) {
      all.push({ index: m.index ?? 0, text: m[0], tracker: s.tracker, id: s.id(m), explicit: s.explicit });
    }
  }
  all.sort((a, b) => a.index - b.index || b.text.length - a.text.length);
  const out: Mention[] = [];
  let end = 0;
  for (const m of all) {
    if (m.index < end) continue;
    out.push(m);
    end = m.index + m.text.length;
  }
  return out;
}

/** The id with its repo filled in, or null when it needs a repo the session doesn't have. */
export function resolveId(tracker: TrackerName, id: string, repo: string | null): string | null {
  if (tracker !== "github") return id;
  if (!id.startsWith("#")) return id.toLowerCase();
  return repo ? `${repo}${id}`.toLowerCase() : null;
}

/** Splits a resolved GitHub id ("owner/repo#123"). */
export function githubId(id: string): { repo: string; n: number } | null {
  const m = id.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? { repo: m[1]!.toLowerCase(), n: Number(m[2]) } : null;
}

export const refKey = (tracker: TrackerName, id: string) => `${tracker}:${id.toLowerCase()}`;

/** Where a resolved id lives, without looking it up. GitHub sends issue URLs on to PRs. */
export function urlFor(tracker: TrackerName, id: string, ctx: TrackerContext): string | null {
  if (tracker === "shortcut") return ctx.shortcutSlug ? `https://app.shortcut.com/${ctx.shortcutSlug}/story/${id}` : null;
  const g = githubId(id);
  return g ? `https://github.com/${g.repo}/issues/${g.n}` : null;
}

/** How an item is written: sc-123, #123 in the session's own repo, owner/repo#123 elsewhere. */
export function labelFor(tracker: TrackerName, id: string, kind: "card" | "issue" | "pr", repo: string | null): string {
  if (tracker === "shortcut") return `sc-${id}`;
  const g = githubId(id);
  if (!g) return id;
  const n = g.repo === repo?.toLowerCase() ? `#${g.n}` : `${g.repo}#${g.n}`;
  return kind === "pr" ? `PR ${n}` : n;
}

/** The work item a session is about: its Shortcut card, else its GitHub issue. */
export function workItem<R extends { source: string; kind: string }>(refs: R[]): R | undefined {
  const own = refs.filter((r) => r.source === "own");
  return own.find((r) => r.kind === "card") ?? own.find((r) => r.kind === "issue");
}
