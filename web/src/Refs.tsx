import type { ReactNode } from "react";
import { parseMentions, refKey, resolveId, urlFor, workItem } from "../../server/mentions.ts";
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
  // GitHub Projects' default Status columns.
  todo: "text-code-dim",
  backlog: "text-code-dim",
  "in progress": "text-code",
  "in review": "text-needs [text-shadow:0_0_4px_rgb(255_176_0/0.6)]",
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
  // The work item: a Shortcut card, else a GitHub issue (its Project Status, or open/closed).
  const card = workItem(own);
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


export function refLabel(r: Ref) {
  return r.label;
}

/** One line per card/PR: number, state, title. Links out without opening the session. */
export function RefList({ refs, className = "" }: { refs: Ref[]; className?: string }) {
  if (refs.length === 0) return null;
  return (
    <ul className={`space-y-0.5 text-xs ${className}`}>
      {refs.map((r) => (
        <li key={r.key} className="flex min-w-0 items-baseline gap-2">
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
// title on hover; one that says what it is (sc-123, PR #123, owner/repo#123) links to where
// it lives. A bare #123 could be anything (a list item, a color), so it only links once it
// resolved to a real issue or PR.
export function WithMentions({ text, s }: { text: string; s: Pick<Session, "refs" | "trackers"> }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of parseMentions(text)) {
    const id = resolveId(m.tracker, m.id, s.trackers.repo);
    const ref = id ? s.refs.find((r) => r.key === refKey(m.tracker, id)) : undefined;
    const href = ref?.url ?? (id && m.explicit ? urlFor(m.tracker, id, s.trackers) : null);
    if (!href) continue;
    parts.push(
      text.slice(at, m.index),
      <a
        key={m.index}
        href={href}
        target="_blank"
        rel="noreferrer"
        title={ref?.title}
        onClick={(e) => e.stopPropagation()}
        className="underline decoration-code-dim decoration-dotted underline-offset-4 hover:decoration-code"
      >
        {m.text}
      </a>,
    );
    at = m.index + m.text.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
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
