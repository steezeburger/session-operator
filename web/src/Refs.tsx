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
 * What a session is about vs. what it only talked about. Only its branch decides what it's
 * about; guessing from mentions kept labeling planning sessions with whatever card came up.
 */
export function focusRefs(s: Session): { own: Ref[]; mentioned: Ref[] } {
  return { own: s.refs.filter((r) => r.source === "own"), mentioned: s.refs.filter((r) => r.source === "mention") };
}

const SHIPPED = "text-[#b48cff] [text-shadow:0_0_4px_rgb(180_140_255/0.6)]";

/**
 * Where a closed session left its work: the PR decides if there is one, then a local merge
 * of its branch, then the card, then how its last turn ended.
 */
export function closedOutcome(s: Session): { text: string; cls: string } {
  const { own } = focusRefs(s);
  const pr = own.find((r) => r.kind === "pr");
  const card = own.find((r) => r.kind === "card");
  if (pr?.state === "merged") return { text: `shipped · ${refLabel(pr)} merged`, cls: SHIPPED };
  if (pr?.state === "open" || pr?.state === "draft") {
    return { text: `left in review · ${refLabel(pr)} ${pr.state}`, cls: "text-blocked" };
  }
  if (pr?.state === "closed") return { text: `abandoned · ${refLabel(pr)} closed`, cls: "text-fail" };
  if (!pr && s.mergedInto) return { text: `shipped · ${s.branch} merged into ${s.mergedInto}`, cls: SHIPPED };
  if (card && (card.state === "released" || card.state === "done")) {
    return { text: `shipped · ${refLabel(card)} ${card.state}`, cls: SHIPPED };
  }
  const where = card ? ` · ${refLabel(card)} ${card.state}` : "";
  if (s.turnEnd === "failing") return { text: `closed while failing${where}`, cls: "text-fail" };
  if (s.turnEnd === "mid-turn") return { text: `abandoned mid-turn${where}`, cls: "text-needs" };
  return { text: `${card ? "no PR" : "finished"}${where}`, cls: "text-code-dim" };
}


/**
 * What to call a session: your /rename if you gave it one (only you change that), else its
 * card or issue title, else Claude Code's AI title. Fixed, so it's findable later; `topic`
 * is the part that moves.
 */
export function sessionName(s: Session): string | null {
  return s.customTitle ?? focusRefs(s).own.find((r) => r.kind !== "pr")?.title ?? focusRefs(s).own[0]?.title ?? s.title;
}

/** True if every word of the filter shows up somewhere in what the session is or was about. */
export function sessionMatches(s: Session, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    s.id, s.project, s.cwd, s.branch, s.customTitle, s.title, s.topic, s.lastPrompt,
    ...s.recentPrompts,
    ...s.refs.flatMap((r) => [r.label, r.title]),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function refLabel(r: Ref) {
  return r.label;
}

/** One line per card/PR: number, state, title. Links out without opening the session. */
export function RefList({ refs, className = "" }: { refs: Ref[]; className?: string }) {
  if (refs.length === 0) return null;
  return (
    <ul className={`space-y-0.5 text-xs ${className}`}>
      {refs.map((r) => (
        <li key={`${r.tracker}:${r.id}`} className="flex min-w-0 items-baseline gap-2">
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

// Card/issue/PR mentions inside Claude's text. A known ref links to its own URL with its
// title on hover; an unlooked-up sc-123 or PR #123 links to the session's tracker prefix.
const MENTION_RE = /(\bsc-\d{2,6}\b|\bPR\s*#?\d{3,6}\b|(?<![\w/])#\d{3,6}\b)/gi;

export function WithMentions({ text, s }: { text: string; s: Pick<Session, "refs" | "refLinks"> }) {
  return (
    <>
      {text.split(MENTION_RE).map((part, i) => {
        if (i % 2 === 0) return part;
        const n = Number(part.match(/\d+$/)?.[0]);
        const tracker = /^sc-/i.test(part) ? "shortcut" : "github";
        const ref = s.refs.find((r) => r.tracker === tracker && r.id === n);
        // A bare #123 could be anything (a list item, a color, another repo), so it only
        // links once it resolved to a real issue or PR. sc-123 and PR #123 say what they are.
        const guess = !part.startsWith("#") && s.refLinks[tracker];
        const href = ref?.url ?? (guess ? `${guess}${n}` : null);
        return href ? (
          <a
            key={i}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={ref?.title}
            onClick={(e) => e.stopPropagation()}
            className="underline decoration-code-dim decoration-dotted underline-offset-4 hover:decoration-code"
          >
            {part}
          </a>
        ) : (
          part
        );
      })}
    </>
  );
}

/** A ref's label as a link, for places that list refs inline. */
export function RefLink({ r }: { r: Ref }) {
  return (
    <a
      href={r.url}
      target="_blank"
      rel="noreferrer"
      title={r.title}
      onClick={(e) => e.stopPropagation()}
      className="underline decoration-code-dim decoration-dotted underline-offset-4 hover:decoration-code"
    >
      {refLabel(r)}
    </a>
  );
}
