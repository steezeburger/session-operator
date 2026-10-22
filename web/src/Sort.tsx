import { useEffect, useRef, useState } from "react";
import type { Effort, PendingDecision, Session } from "../../server/types.ts";
import { focusRefs } from "./Refs.tsx";

// How rows sort inside each group, and what the left column shows for each row. Groups keep
// their order; only the rows within them move.

export type SortDir = "asc" | "desc";

export interface SortCtx {
  now: number;
  pendingFor: (id: string) => PendingDecision[];
}

interface SortDef {
  key: string;
  label: string;
  dir: SortDir;
  /** Null sorts last whichever way you sort. */
  value: (s: Session, c: SortCtx) => number | string | null;
  /** The left column's text for this sort. Effort draws bars instead. */
  cell: (s: Session, c: SortCtx) => string | null;
}

export function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

// How long an ask takes to understand and decide. Approvals add up, they're all waiting at once.
export function effortOf(s: Session, pending: PendingDecision[]): Effort | null {
  if (pending.length === 0) return s.effort;
  const known = pending.map((p) => p.effort).filter((e): e is Effort => e !== null);
  if (known.length === 0) return null;
  if (known.length === 1) return known[0] ?? null;
  return { minutes: known.reduce((n, e) => n + e.minutes, 0), why: `${known.length} asks` };
}

// When it became your move: its oldest open approval, else when its turn ended.
function waitingSince(s: Session, c: SortCtx): string {
  return c.pendingFor(s.id).map((p) => p.createdAt).sort()[0] ?? s.lastActivity;
}

const ownRef = (s: Session, kind: "pr" | "card") => focusRefs(s).own.find((r) => r.kind === kind) ?? null;

// Shortcut state names are per workspace, so rank by what they sound like. Lower is nearer done.
function stateRank(state: string): number {
  if (/released|done|complete|shipped/.test(state)) return 0;
  if (/test|qa|review|staging|verify/.test(state)) return 1;
  if (/build|progress|develop|doing/.test(state)) return 2;
  return 3;
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : null);

export const SORTS: SortDef[] = [
  {
    key: "activity",
    label: "activity",
    dir: "desc",
    value: (s) => time(s.lastActivity),
    cell: (s, c) => ago(s.lastActivity, c.now),
  },
  {
    key: "waiting",
    label: "waiting longest",
    dir: "asc",
    value: (s, c) => time(waitingSince(s, c)),
    cell: (s, c) => ago(waitingSince(s, c), c.now),
  },
  {
    key: "effort",
    label: "effort",
    dir: "desc",
    value: (s, c) => effortOf(s, c.pendingFor(s.id))?.minutes ?? null,
    cell: () => null,
  },
  {
    key: "pr",
    label: "pr #",
    dir: "desc",
    value: (s) => ownRef(s, "pr")?.id ?? null,
    cell: (s) => {
      const pr = ownRef(s, "pr");
      return pr ? `#${pr.id}` : null;
    },
  },
  {
    key: "card",
    label: "card #",
    dir: "desc",
    value: (s) => ownRef(s, "card")?.id ?? null,
    cell: (s) => ownRef(s, "card")?.label ?? null,
  },
  {
    key: "started",
    label: "started",
    dir: "desc",
    value: (s) => time(s.startedAt),
    cell: (s, c) => (s.startedAt ? ago(s.startedAt, c.now) : null),
  },
  {
    key: "repo",
    label: "repo",
    dir: "asc",
    value: (s) => (s.repo ?? s.project).toLowerCase(),
    cell: (s) => s.repo ?? s.project,
  },
  {
    key: "state",
    label: "card state",
    dir: "asc",
    value: (s) => {
      const card = ownRef(s, "card");
      return card ? stateRank(card.state) : null;
    },
    cell: (s) => ownRef(s, "card")?.state ?? null,
  },
];

const DEFAULT = SORTS[0] as SortDef;
const KEY = "operator.sort";

export interface Sort {
  def: SortDef;
  dir: SortDir;
}

// Remembered per browser. Storage can be missing (private window), so it falls back quietly.
export function useSort(): [Sort, (key: string) => void, () => void] {
  const [sort, setSort] = useState<Sort>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as { key?: string; dir?: SortDir } | null;
      const def = SORTS.find((d) => d.key === saved?.key);
      if (def) return { def, dir: saved?.dir === "asc" || saved?.dir === "desc" ? saved.dir : def.dir };
    } catch {}
    return { def: DEFAULT, dir: DEFAULT.dir };
  });
  const save = (next: Sort) => {
    setSort(next);
    try {
      localStorage.setItem(KEY, JSON.stringify({ key: next.def.key, dir: next.dir }));
    } catch {}
  };
  const pick = (key: string) => {
    const def = SORTS.find((d) => d.key === key) ?? DEFAULT;
    save({ def, dir: def.dir });
  };
  const flip = () => save({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" });
  return [sort, pick, flip];
}

/** Sorted copy. Rows without a value go last; ties go to the most recently active. */
export function sortRows(rows: Session[], { def, dir }: Sort, c: SortCtx): Session[] {
  const sign = dir === "asc" ? 1 : -1;
  const keyed = rows.map((s) => ({ s, v: def.value(s, c) }));
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) {
      if (a.v !== b.v) return a.v === null ? 1 : -1;
    } else if (a.v !== b.v) {
      return (a.v < b.v ? -1 : 1) * sign;
    }
    return b.s.lastActivity.localeCompare(a.s.lastActivity);
  });
  return keyed.map((k) => k.s);
}

// A menu of our own, not a <select>: the browser's native picker gets no pointer events to the
// page, so the list thinks you've stopped aiming, re-sorts under it, and the picker closes unpicked.
export function SortControl({ sort, onPick, onFlip }: { sort: Sort; onPick: (key: string) => void; onFlip: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  return (
    <div ref={box} className="relative flex w-full items-center gap-1 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="sort rows by"
        className={`flex min-w-0 flex-1 items-center justify-between border px-1 ${open ? "border-code bg-code text-black [text-shadow:none]" : "border-code-dark text-code hover:border-code-dim"}`}
      >
        <span className="truncate">{sort.def.label}</span>
        <span>▾</span>
      </button>
      <button
        type="button"
        onClick={onFlip}
        title={sort.dir === "asc" ? "ascending, click to flip" : "descending, click to flip"}
        className="shrink-0 border border-code-dark px-1 text-code hover:border-code-dim"
      >
        {sort.dir === "asc" ? "↑" : "↓"}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 flex w-40 flex-col border border-code bg-black text-left shadow-lg">
          {SORTS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(d.key);
              }}
              className={`whitespace-pre px-2 py-1 text-left hover:bg-code hover:text-black hover:[text-shadow:none] ${d.key === sort.def.key ? "font-bold text-white" : ""}`}
            >
              {d.key === sort.def.key ? "› " : "  "}
              {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
