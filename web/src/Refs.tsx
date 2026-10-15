import type { Ref, Session } from "../../server/types.ts";

const STATE_STYLE: Record<string, string> = {
  open: "text-code",
  draft: "text-code-dim",
  merged: "text-[#b48cff] [text-shadow:0_0_4px_rgb(180_140_255/0.6)]",
  closed: "text-fail",
  build: "text-code",
  test: "text-needs [text-shadow:0_0_4px_rgb(255_176_0/0.6)]",
  paused: "text-code-dim",
  released: "text-[#b48cff] [text-shadow:0_0_4px_rgb(180_140_255/0.6)]",
  done: "text-[#b48cff] [text-shadow:0_0_4px_rgb(180_140_255/0.6)]",
};

/**
 * What a session is about vs. what it only talked about. Its branch card/PR are its own.
 * A session on main that keeps coming back to one card (twice as often as any other) is
 * working that card; one spread across several (planning, triage, "what's next") is meta.
 */
export function focusRefs(s: Session): { own: Ref[]; mentioned: Ref[]; meta: boolean } {
  const own = s.refs.filter((r) => r.source === "own");
  const mentions = s.refs.filter((r) => r.source === "mention");
  if (own.length > 0) return { own, mentioned: mentions, meta: false };
  const [first, second] = mentions.filter((r) => r.kind === "card").sort((a, b) => b.mentions - a.mentions);
  if (first && (!second || first.mentions >= 2 * second.mentions)) {
    return { own: [first], mentioned: mentions.filter((r) => r !== first), meta: false };
  }
  return { own: [], mentioned: mentions, meta: mentions.length > 0 };
}

export function MetaTag() {
  return (
    <span
      title="Talks about several cards/PRs without working on one (planning, triage)"
      className="border border-code-dim px-1 text-[10px] uppercase tracking-widest text-code-dim"
    >
      meta
    </span>
  );
}

export function refLabel(r: Ref) {
  return r.kind === "card" ? `sc-${r.id}` : `PR #${r.id}`;
}

/** One line per card/PR: number, state, title. Links out without opening the session. */
export function RefList({ refs, className = "" }: { refs: Ref[]; className?: string }) {
  if (refs.length === 0) return null;
  return (
    <ul className={`space-y-0.5 text-xs ${className}`}>
      {refs.map((r) => (
        <li key={`${r.kind}${r.id}`} className="flex min-w-0 items-baseline gap-2">
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 border border-code-dim px-1 font-bold text-white hover:border-code hover:bg-code hover:text-black hover:[text-shadow:none]"
          >
            {refLabel(r)} ↗
          </a>
          <span className={`shrink-0 uppercase ${STATE_STYLE[r.state] ?? "text-code-dim"}`}>{r.state}</span>
          <span className="min-w-0 truncate" title={r.title}>
            {r.title}
          </span>
        </li>
      ))}
    </ul>
  );
}

// PR/card mentions inside Claude's text, matched to a known ref so hovering shows its title.
const MENTION_RE = /(\bsc-\d{2,6}\b|\bPR\s*#?\d{3,6}\b|(?<![\w/])#\d{3,6}\b)/gi;

export function WithMentions({ text, refs }: { text: string; refs: Ref[] }) {
  if (refs.length === 0) return <>{text}</>;
  return (
    <>
      {text.split(MENTION_RE).map((part, i) => {
        const n = Number(part.match(/\d+$/)?.[0]);
        const kind = /^sc-/i.test(part) ? "card" : "pr";
        const ref = i % 2 === 1 ? refs.find((r) => r.kind === kind && r.id === n) : undefined;
        return ref ? (
          <abbr key={i} title={ref.title} className="cursor-help no-underline decoration-dotted underline-offset-4 [text-decoration-line:underline]">
            {part}
          </abbr>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}
