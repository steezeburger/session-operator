import { type CSSProperties, Fragment, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Behavior, Effort, OperatorState, PendingDecision, PermissionUpdate, Session, SessionStatus } from "../../server/types.ts";
import { setFavicon } from "./favicon.ts";
import { MatrixRain } from "./MatrixRain.tsx";
import { closedOutcome, focusRefs, RefLink, RefList, sessionMatches, sessionName } from "./Refs.tsx";
import { PauseMenu, untilLabel } from "./Pause.tsx";
import { TermButton } from "./TermButton.tsx";
import { WithPaths } from "./Paths.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { SessionDetail } from "./SessionDetail.tsx";
import { ago, effortOf, type Sort, SortControl, type SortCtx, sortRows, useSort } from "./Sort.tsx";

// Six meanings only: amber = needs the user, red = failing, cyan = waiting on the world (CI, deploy),
// bright green = running, dark green = idle, outline = closed.
const NEEDS_YOU = "bg-needs text-black [text-shadow:none] pulse";
const STATUS_STYLE: Record<SessionStatus, { label: string; block: string; next: string }> = {
  waiting: { label: "NEEDS YOU", block: NEEDS_YOU, next: "Answer it" },
  done: { label: "YOUR MOVE", block: NEEDS_YOU, next: "Read + reply" },
  failing: { label: "FAILING", block: "bg-fail text-black [text-shadow:none]", next: "Check on it" },
  working: { label: "WORKING", block: "bg-code text-black [text-shadow:none]", next: "Let it run" },
  blocked: { label: "WAITING ON", block: "bg-blocked text-black [text-shadow:none]", next: "-" },
  idle: { label: "IDLE", block: "bg-code-dark text-code-dim", next: "-" },
  closed: { label: "CLOSED", block: "border border-code-dim text-code-dim", next: "-" },
};

const GROUPS: { key: string; title: string; statuses: SessionStatus[]; color: string }[] = [
  { key: "needs", title: "Needs you", statuses: ["waiting", "done"], color: "bg-needs" },
  { key: "failing", title: "Failing", statuses: ["failing"], color: "bg-fail" },
  { key: "blocked", title: "Waiting on something", statuses: ["blocked"], color: "bg-blocked" },
  { key: "working", title: "Working", statuses: ["working"], color: "bg-code" },
];

const BORDER = "border border-code-dim";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function useOperatorState() {
  const [state, setState] = useState<OperatorState | null>(null);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state");
      setState(await res.json());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.addEventListener("change", () => void refresh());
    events.onerror = () => setOffline(true);
    // The server pushes a change for every hook event and transcript write. This only catches what
    // a dropped connection or a missed file event let slip.
    const poll = setInterval(() => void refresh(), 30_000);
    return () => {
      events.close();
      clearInterval(poll);
    };
  }, [refresh]);

  return { state, offline, refresh };
}

// How long a row that's about to move shades in for, and how long the pointer has to rest before
// the list may change under it.
const COUNT_MS = 700;
const QUIET_MS = 500;
// The longest the list waits on you, so a missed pointerup or a forgotten draft can't freeze it.
const MAX_HOLD_MS = 4000;

/** Names a list element so it slides, fades or morphs between snapshots instead of jumping. */
function vt(name: string): CSSProperties {
  return { viewTransitionName: name.replace(/[^\w-]/g, "_") };
}

// Where each row lives in the list: the group (or section) it's drawn in, by id.
function placements(st: OperatorState): Map<string, string> {
  const v = sortState(st);
  const at = new Map<string, string>();
  for (const p of v.approvals) at.set(p.id, "approve");
  for (const g of v.groups) for (const s of g.rows) at.set(s.id, g.key);
  for (const s of v.paused) at.set(s.id, "paused");
  for (const s of v.idle) at.set(s.id, "idle");
  for (const s of v.closed) at.set(s.id, "closed");
  return at;
}

const PLACE_NAMES: Record<string, string> = {
  approve: "approve",
  ...Object.fromEntries(GROUPS.map((g) => [g.key, g.title.toLowerCase()])),
  paused: "paused",
  idle: "idle",
  closed: "closed",
};

// Over a row a held update will move to another group, or drop, so you don't aim at it. The
// shade sweeps in from the left over COUNT_MS (`useCalmState`), then stays until the row moves. An overlay, not opacity: the pulsing "needs you" stripe drowns out a plain dim.
function Leaving({ to }: { to: string | undefined }) {
  if (to === undefined) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-end px-2 outline-1 outline-offset-1 outline-dashed outline-code-dim">
      <div data-countdown className="absolute inset-0 origin-left scale-x-0 bg-black/60 motion-reduce:scale-x-100" />
      <span className="relative border border-code-dim bg-black px-1.5 text-xs font-bold uppercase text-code-dim [text-shadow:none]">→ {to}</span>
    </div>
  );
}

// Where each thing sits in the list. Other changes (text, times, a status within its group) land
// without a transition.
function layoutKey(st: OperatorState) {
  const v = sortState(st);
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  return JSON.stringify([ids(v.approvals), v.groups.map((g) => ids(g.rows)), ids(v.idle), ids(v.closed), ids(v.pending)]);
}

/**
 * The state the session list draws from. An update that moves rows first shades those rows in
 * over COUNT_MS (`leaving` names them, and where to), then lands animated once you've stopped
 * aiming at the list: pointer still and no scroll for QUIET_MS, no button held, nothing typed in
 * it. Text-only updates just wait for that.
 */
function useCalmState(live: OperatorState | null, list: RefObject<HTMLElement | null>, animate: boolean) {
  const [shown, setShown] = useState(live);
  const [settled, setSettled] = useState(true);
  // Starts the shade for rows not shaded yet.
  const countRef = useRef<() => void>(() => {});
  // The rows shaded now, and the ones shaded when the count last started: a move lands only once
  // every row it moves has been shaded.
  const shading = useRef(new Set<string>());
  const counted = useRef(new Set<string>());

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let down = false;
    let aimedAt = -Infinity;
    let countEnds = 0;
    let heldSince = 0;
    const typing = () => {
      const a = document.activeElement;
      return (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) && el.contains(a) && a.value !== "";
    };
    const check = () => {
      clearTimeout(timer);
      const now = performance.now();
      const wait = Math.max(countEnds - now, aimedAt + QUIET_MS - now, down || typing() ? QUIET_MS : 0);
      const left = heldSince + MAX_HOLD_MS - now;
      if (wait > 0 && left > 0) timer = setTimeout(check, Math.min(wait, left));
      else {
        heldSince = 0;
        down = false;
        setSettled(true);
      }
    };
    const hold = () => {
      if (!heldSince) heldSince = performance.now();
      setSettled(false);
    };
    const aim = () => {
      aimedAt = performance.now();
      hold();
      check();
    };
    // Runs once per shade; one already full stays full, so moving the pointer never replays it.
    const count = () => {
      counted.current = new Set(shading.current);
      countEnds = performance.now() + COUNT_MS;
      hold();
      if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
        for (const shade of el.querySelectorAll("[data-countdown]")) {
          if (shade.getAnimations().length === 0) {
            shade.animate([{ scale: "0 1" }, { scale: "1 1" }], { duration: COUNT_MS, fill: "forwards" });
          }
        }
      }
      check();
    };
    const press = () => {
      down = true;
      aim();
    };
    const release = () => {
      down = false;
    };
    countRef.current = count;
    el.addEventListener("pointermove", aim);
    el.addEventListener("pointerdown", press);
    el.addEventListener("input", aim);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("scroll", aim, { passive: true });
    window.addEventListener("blur", release);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointermove", aim);
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("input", aim);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("scroll", aim);
      window.removeEventListener("blur", release);
    };
  }, [list]);

  useEffect(() => {
    if (!live || live === shown) return;
    const moves = shown && layoutKey(live) !== layoutKey(shown);
    // Shade a move's rows the moment it arrives, aiming or not.
    if (moves && ![...movedRows(shown, live).keys()].every((id) => counted.current.has(id))) {
      countRef.current();
      return;
    }
    if (shown && !settled) return;
    if (shown && JSON.stringify(live) === JSON.stringify(shown)) return;
    if (moves) counted.current = new Set();
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (moves && animate && !still && document.startViewTransition) document.startViewTransition(() => flushSync(() => setShown(live)));
    else setShown(live);
  }, [live, shown, settled, animate]);

  // Row id -> where it's going.
  const leaving = live && shown ? movedRows(shown, live) : new Map<string, string>();
  shading.current = new Set(leaving.keys());
  return { shown, leaving };
}

// The state as it will be once the server catches up on what you just answered: those sessions
// back at work, those approvals gone. So your own answer moves its row without waiting on a poll.
function withSent(st: OperatorState | null, sent: Set<string>): OperatorState | null {
  if (!st || sent.size === 0) return st;
  return {
    pending: st.pending.filter((p) => !sent.has(p.id) && !sent.has(p.sessionId)),
    sessions: st.sessions.map((s) =>
      sent.has(s.id) && (s.status === "waiting" || s.status === "done") ? { ...s, status: "working" as const } : s,
    ),
  };
}

// Rows that sit somewhere else in `next`, or not at all: id -> where they go.
function movedRows(cur: OperatorState, next: OperatorState) {
  const to = placements(next);
  const moved = new Map<string, string>();
  for (const [id, at] of placements(cur)) {
    const dest = to.get(id);
    if (dest !== at) moved.set(id, dest ? (PLACE_NAMES[dest] ?? dest) : "gone");
  }
  return moved;
}

// Everything the page shows, sorted into where it goes.
function sortState(state: OperatorState | null, query = "") {
  const all = state?.sessions ?? [];
  // The running operator gets its own strip; the rest are the sessions it runs.
  const operators = all.filter((s) => s.role === "operator" && s.live);
  const everyone = all.filter((s) => !operators.includes(s));
  // What the filter lets through. Groups list those; `allGroups` counts everyone.
  const sessions = everyone.filter((s) => sessionMatches(s, query));
  // Paused ones sit in their own group, whatever their status, and count for nothing up top.
  const active = sessions.filter((s) => !s.paused);
  const pending = state?.pending ?? [];
  const operatorIds = new Set(operators.map((s) => s.id));
  const grouped = (from: Session[]) => GROUPS.map((g) => ({ ...g, rows: from.filter((s) => g.statuses.includes(s.status)) }));
  return {
    all,
    operators,
    everyone,
    sessions,
    pending,
    paused: sessions.filter((s) => s.paused),
    pausedCount: everyone.filter((s) => s.paused).length,
    idle: active.filter((s) => s.status === "idle"),
    closed: active.filter((s) => s.status === "closed"),
    // Approvals show inside their session's card. Only one whose session isn't listed gets its own.
    approvals: pending.filter((p) => !operatorIds.has(p.sessionId) && !everyone.some((s) => s.id === p.sessionId)),
    groups: grouped(active),
    allGroups: grouped(everyone.filter((s) => !s.paused)),
  };
}

function GroupHeader({
  name,
  title,
  count,
  color,
  lead,
  children,
}: {
  name: string;
  title: string;
  count: number;
  color: string;
  /** Goes in the left column's slot on this line: the sort control, on the first header. */
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <div className={GUTTER}>{lead}</div>
      <h2 style={vt(`g-${name}`)} className="flex min-w-0 flex-1 items-center gap-2 text-xs font-bold uppercase tracking-widest">
        <span className={`inline-block h-2.5 w-2.5 ${color}`} />
        {">"} {title} [{count}]
        {children && <span className="ml-auto font-normal normal-case tracking-normal">{children}</span>}
      </h2>
    </div>
  );
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
}

const OPTION = "border px-2 py-1 text-left text-sm [text-shadow:none]";

/** AskUserQuestion as clickable options. A lone single-choice question sends on click. */
function QuestionForm({ questions, onAnswer }: { questions: Question[]; onAnswer: (answers: Record<string, string>) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const typed = (q: Question | undefined) => (q ? (other[q.question]?.trim() ?? "") : "");
  const answerFor = (q: Question) => [...(picked[q.question] ?? []), ...(typed(q) ? [typed(q)] : [])];
  const ready = questions.every((q) => answerFor(q).length > 0);
  const instant = questions.length === 1 && !questions[0]?.multiSelect;
  const send = () => onAnswer(Object.fromEntries(questions.map((q) => [q.question, answerFor(q).join(", ")])));

  const pick = (q: Question, label: string) => {
    if (instant) return onAnswer({ [q.question]: label });
    setPicked((cur) => {
      const now = cur[q.question] ?? [];
      const next = q.multiSelect ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label];
      return { ...cur, [q.question]: next };
    });
  };

  return (
    <div className="mt-1 space-y-3">
      {questions.map((q) => (
        <fieldset key={q.question} className="min-w-0">
          <legend className="text-sm text-white">
            {q.header && <span className="mr-2 border border-code-dim px-1 text-xs uppercase text-code-dim">{q.header}</span>}
            {q.question}
            {q.multiSelect && <span className="ml-2 text-xs text-code-dim">(pick any)</span>}
          </legend>
          <div className="mt-1 grid gap-1">
            {(q.options ?? []).map((o) => {
              const on = (picked[q.question] ?? []).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => pick(q, o.label)}
                  className={`${OPTION} ${on ? "border-code bg-code text-black" : "border-code-dim bg-black hover:border-code"}`}
                >
                  <span className="font-bold">{o.label}</span>
                  {o.description && <span className={`ml-2 text-xs ${on ? "text-black" : "text-code-dim"}`}>{o.description}</span>}
                </button>
              );
            })}
            <input
              value={other[q.question] ?? ""}
              onChange={(e) => setOther((cur) => ({ ...cur, [q.question]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) send();
              }}
              placeholder="other..."
              className="border border-code-dark bg-black px-2 py-1 text-sm text-code placeholder:text-code-dim focus:border-code focus:outline-none"
            />
          </div>
        </fieldset>
      ))}
      {(!instant || typed(questions[0])) && (
        <button
          type="button"
          disabled={!ready}
          onClick={send}
          className="border border-code bg-code px-5 py-1 text-sm font-bold uppercase text-black [text-shadow:none] enabled:hover:bg-black enabled:hover:text-code disabled:opacity-40"
        >
          Send answers
        </button>
      )}
    </div>
  );
}

/** What the terminal's "Yes, and don't ask again ..." option says for one suggested rule. */
function suggestionLabel(u: PermissionUpdate): string {
  const where =
    u.destination === "session"
      ? " this session"
      : u.destination === "localSettings" || u.destination === "projectSettings"
        ? " in this project"
        : u.destination === "userSettings"
          ? " anywhere"
          : "";
  if (u.type === "addRules" && u.rules?.length) {
    const rules = u.rules.map((x) => (x.ruleContent ? `${x.toolName}(${x.ruleContent})` : x.toolName)).join(", ");
    return `don't ask again for ${rules}${where}`;
  }
  if (u.type === "setMode" && u.mode) return `switch to ${u.mode} mode${where}`;
  if (u.type === "addDirectories" && u.directories?.length) return `allow ${u.directories.join(", ")}${where}`;
  return u.type;
}

export type DecideExtra = { answers?: Record<string, string>; suggestion?: number };

// `inline`: drawn inside its session's card, which already says which session it is.
function PendingCard({
  p,
  now,
  inline = false,
  onDecide,
}: {
  p: PendingDecision;
  now: number;
  inline?: boolean;
  onDecide: (b: Behavior, extra?: DecideExtra) => void;
}) {
  const waited = Math.max(0, Math.round((now - new Date(p.createdAt).getTime()) / 1000));
  const questions = p.toolName === "AskUserQuestion" ? ((p.toolInput as { questions?: Question[] } | null)?.questions ?? null) : null;
  const input = JSON.stringify(p.toolInput, null, 2);
  const project = p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
  return (
    <article className={`flex border border-needs bg-black/85 ${inline ? "mt-2" : "glow-needs"}`}>
      {!inline && <div className="w-2 shrink-0 bg-needs pulse" />}
      <div className="min-w-0 flex-1 p-2">
        <div className="flex items-baseline justify-between gap-4 text-xs uppercase text-needs [text-shadow:0_0_4px_rgb(255_176_0/0.6)]">
          <span className="font-bold">
            {inline ? p.toolName : `${project} → ${p.toolName}`}
          </span>
          <span>also in its terminal · {waited < 60 ? `${waited}s` : `${Math.round(waited / 60)}m`}</span>
        </div>
        {p.detail && <p className="mt-1 text-sm text-white">{p.detail}</p>}
        {questions ? (
          <QuestionForm questions={questions} onAnswer={(answers) => onDecide("allow", { answers })} />
        ) : (
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all border border-code-dark bg-code-dark/40 px-2 py-1 text-xs">
            {p.summary}
          </pre>
        )}
        {!questions && input && input !== JSON.stringify(p.summary) && (
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer uppercase text-code-dim">Full tool input</summary>
            <pre className={`${BORDER} mt-1 max-h-64 overflow-auto p-2`}>{input}</pre>
          </details>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!questions && <button
            type="button"
            onClick={() => onDecide("allow")}
            className="border border-code bg-code px-5 py-1 text-sm font-bold uppercase text-black [text-shadow:none] hover:bg-black hover:text-code hover:[text-shadow:0_0_4px_rgb(0_255_65/0.6)]"
          >
            Approve
          </button>}
          {!questions &&
            p.suggestions.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onDecide("allow", { suggestion: i })}
                title={JSON.stringify(u)}
                className="max-w-full truncate border border-code px-3 py-1 text-left text-sm font-bold text-code hover:bg-code hover:text-black hover:[text-shadow:none]"
              >
                Yes, {suggestionLabel(u)}
              </button>
            ))}
          <button
            type="button"
            onClick={() => onDecide("deny")}
            className="border border-fail bg-fail px-5 py-1 text-sm font-bold uppercase text-black [text-shadow:none] hover:bg-black hover:text-fail"
          >
            {questions ? "Skip" : "Deny"}
          </button>
          {!inline && <span className="ml-2 truncate text-xs text-code-dim">{p.cwd}</span>}
        </div>
      </div>
    </article>
  );
}

// Name the repo, not the worktree folder; the branch or card says which worktree.
function repoName(s: Session) {
  return s.repo ?? s.project;
}

function SessionRow({ s, now, leaving, onOpen }: { s: Session; now: number; leaving: string | undefined; onOpen: () => void }) {
  const style = STATUS_STYLE[s.status];
  const { own: refs } = focusRefs(s);
  const outcome = s.status === "closed" ? closedOutcome(s) : null;
  const next =
    outcome?.text ??
    (s.paused ? `paused ${untilLabel(s, now)}` : null) ??
    (s.status === "blocked" ? (s.blockedOn ?? "-") : s.status === "waiting" || s.status === "failing" ? s.statusDetail : style.next);
  return (
    // A div, not a button: it holds ref links, and links can't nest in a button.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      style={vt(`s-${s.id}`)}
      className="group relative grid w-full cursor-pointer grid-cols-[5.5rem_1fr_2.5rem] items-stretch text-left text-xs leading-tight hover:bg-code-dark/50 md:grid-cols-[5.5rem_15rem_1fr_14rem_2.5rem]"
    >
      {/* Paused: its real status, minus the pulse, since you've put it off. */}
      <div className={`px-1.5 py-0.5 font-bold ${s.paused ? style.block.replace("pulse", "opacity-60") : style.block}`}>{style.label}</div>
      <div className="min-w-0 truncate px-1.5 py-0.5" title={`${s.cwd}${s.branch ? ` (${s.branch})` : ""}`}>
        <span className="font-bold">{repoName(s)}</span>
        {refs.length > 0 ? (
          <span className="text-white">
            {refs.map((r, i) => (
              <span key={`${r.tracker}:${r.id}`}>
                {i === 0 ? " " : " · "}
                <RefLink r={r} />
              </span>
            ))}
          </span>
        ) : (
          s.branch && <span className="text-code-dim"> {s.branch}</span>
        )}
      </div>
      <div className="hidden min-w-0 truncate px-1.5 py-0.5 md:block" title={[sessionName(s), s.topic && `now: ${s.topic}`].filter(Boolean).join("\n") || undefined}>
        {sessionName(s) ?? "-"}
        {s.topic && <span className="text-code-dim"> · now: {s.topic}</span>}
      </div>
      <div
        className={`hidden truncate px-1.5 py-0.5 font-bold uppercase md:block ${s.status === "blocked" ? "text-blocked [text-shadow:0_0_4px_rgb(0_229_255/0.6)]" : (outcome?.cls ?? "")}`}
        title={next}
      >
        {next}
      </div>
      <div className="px-1.5 py-0.5 text-right text-code-dim">{ago(s.lastActivity, now)}</div>
      {/* Over the row's right end on hover, so the grid keeps its columns. */}
      <div className="absolute right-12 top-0 hidden group-hover:block">
        <TermButton s={s} />
      </div>
      <Leaving to={leaving} />
    </div>
  );
}

const OPERATOR_INPUT = "operator-input";

// The operator is always just the operator: no card, title or next step borrowed from the
// sessions it talks about. White is its color and nobody else's. Pinned, so it's one glance
// and one keystroke away however far down the list you are.
function OperatorConsole({
  s,
  now,
  pending,
  tally,
  onOpen,
  onDecide,
}: {
  s: Session;
  now: number;
  pending: PendingDecision[];
  tally: { title: string; count: number; color: string }[];
  onOpen: () => void;
  onDecide: (id: string, b: Behavior, extra?: DecideExtra) => void;
}) {
  const waiting = s.status === "waiting" || pending.length > 0;
  const busy = s.status === "working";
  const style = waiting ? STATUS_STYLE.waiting : busy ? STATUS_STYLE.working : null;
  // What it's doing now, or what it last said to you.
  const line = pending.length > 0
    ? null
    : waiting
      ? s.statusDetail
      : busy
        ? s.lastPrompt && `on: ${s.lastPrompt}`
        : s.lastReply;
  return (
    <article className={`${waiting ? "glow-needs border-needs" : "glow-op border-white"} mt-2 flex border bg-black`}>
      <div className={`w-2 shrink-0 ${waiting ? "pulse bg-needs" : busy ? "bg-code" : "bg-white"}`} />
      <div className="min-w-0 flex-1 p-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left text-xs hover:bg-code-dark/50"
            title={s.cwd}
          >
            <span className={`px-1.5 py-0.5 font-bold ${style?.block ?? "bg-white text-black [text-shadow:none]"}`}>
              {style?.label ?? "READY"}
            </span>
            <span className="font-bold uppercase tracking-widest text-white [text-shadow:0_0_6px_rgb(255_255_255/0.6)]">
              Operator
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-3 text-code-dim">
              {tally.map((t) => (
                <span key={t.title} className="hidden items-center gap-1 sm:flex" title={t.title}>
                  <span className={`inline-block h-2 w-2 ${t.color}`} />
                  {t.count} {t.title.toLowerCase()}
                </span>
              ))}
              <span>{ago(s.lastActivity, now)}</span>
            </span>
          </button>
          <TermButton s={s} />
        </div>
        {line && (
          <button
            type="button"
            onClick={onOpen}
            title={line}
            className={`mt-1 line-clamp-3 w-full cursor-pointer text-left text-sm ${waiting ? "font-bold text-needs" : busy ? "text-code-dim" : "text-white"}`}
          >
            {"› "}
            <WithCode text={line} s={s} />
          </button>
        )}
        {pending.length > 0 && (
          <div className="mt-2 max-h-[45vh] space-y-2 overflow-y-auto">
            {pending.map((p) => (
              <PendingCard key={p.id} p={p} now={now} onDecide={(b, a) => onDecide(p.id, b, a)} />
            ))}
          </div>
        )}
        {pending.length === 0 && (
          <ReplyBox
            sessionId={s.id}
            says={s.nextSays}
            inputId={OPERATOR_INPUT}
            placeholder="tell the operator (o to jump here, shift+enter for a new line)"
          />
        )}
      </div>
    </article>
  );
}

// One imperative line per "needs you" session: what the user does next, not what Claude did.
function nextStep(s: Session): string {
  if (s.status === "waiting") return `In its terminal: ${s.statusDetail}`;
  if (s.nextAction) return s.nextAction;
  return s.nextLoading ? "" : "No clear ask - open it to see the last message";
}

// Four bars, like phone signal, but more bars is more of your time: <1m, under 5m, under 15m, 15m+.
// Quick ones are green, slow ones amber (red stays for failing), and the heaviest glows.
// Unlit while it's still being estimated. Hover for the why.
const EFFORT_STEPS = [1, 5, 15];

function effortTime(minutes: number) {
  return minutes < 1 ? "<1m" : minutes < 60 ? `~${minutes}m` : `~${Math.round(minutes / 30) / 2}h`;
}

function EffortBars({ effort }: { effort: Effort | null }) {
  const level = effort ? 1 + EFFORT_STEPS.filter((m) => effort.minutes >= m).length : 0;
  const lit = level <= 2 ? "bg-code" : level === 3 ? "bg-needs" : "bg-needs shadow-[0_0_6px_rgb(255_176_0/0.9)]";
  return (
    <span className="group relative flex items-center gap-1.5 text-xs [text-shadow:none]">
      <span className="flex h-4 shrink-0 items-end gap-0.5">
        {[1, 2, 3, 4].map((bar) => (
          <span key={bar} className={`w-1.5 ${bar <= level ? lit : "bg-code-dark"}`} style={{ height: `${bar * 25}%` }} />
        ))}
      </span>
      {effort && <span className={level >= 3 ? "font-bold text-needs" : "text-code-dim"}>{effortTime(effort.minutes)}</span>}
      <span className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden whitespace-nowrap border border-code-dim bg-black px-2 py-1 font-normal text-code-dim group-hover:block">
        {effort ? (
          <>
            <span className={`font-bold ${level >= 3 ? "text-needs" : "text-code"}`}>{effortTime(effort.minutes)}</span>
            {effort.why && <span className="text-white"> · {effort.why}</span>}
            <span className="block">rough time to understand and decide, not to click</span>
          </>
        ) : (
          "no estimate yet"
        )}
      </span>
    </span>
  );
}

// The left column: one fixed-width cell per row, so whatever it shows lines up down the list.
const GUTTER = "w-24 shrink-0 sm:w-28";
// Lines a collapsed group's title up with the rows: the column plus the gap after it.
const PAST_GUTTER = "ml-[6.5rem] sm:ml-[7.5rem]";

// Needs-you rows always show their effort; any other sort adds its value underneath.
function NeedsCell({ s, sort, ctx }: { s: Session; sort: Sort; ctx: SortCtx }) {
  const value = sort.def.key === "effort" ? null : sort.def.cell(s, ctx);
  return (
    <div className={`${GUTTER} pt-2 text-xs`}>
      <EffortBars effort={effortOf(s, ctx.pendingFor(s.id))} />
      {value && (
        <div className="mt-1 truncate text-code-dim" title={`${sort.def.label}: ${value}`}>
          {value}
        </div>
      )}
    </div>
  );
}

// Table rows are one line: just the sort's value.
function rowCell(s: Session, sort: Sort, ctx: SortCtx): string {
  if (sort.def.key === "effort") {
    const e = effortOf(s, ctx.pendingFor(s.id));
    return e ? effortTime(e.minutes) : "-";
  }
  return sort.def.cell(s, ctx) ?? "-";
}

// `code` spans from Claude's text, shown as bright chips so commands stand out.
function WithCode({ text, s }: { text: string; s: Session }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="bg-code-dark px-1 normal-case text-white [text-shadow:0_0_4px_rgb(214_255_223/0.6)]">
            <WithPaths text={part.slice(1, -1)} s={s} />
          </code>
        ) : (
          <WithPaths key={i} text={part} s={s} />
        ),
      )}
    </>
  );
}

function NeedsYouCard({
  s,
  now,
  pending,
  leaving,
  onOpen,
  onDecide,
  onSent,
  cell,
}: {
  s: Session;
  now: number;
  pending: PendingDecision[];
  leaving: string | undefined;
  cell: ReactNode;
  onOpen: () => void;
  onDecide: (id: string, b: Behavior, extra?: DecideExtra) => void;
  onSent: () => void;
}) {
  const action = nextStep(s);
  const focus = focusRefs(s);
  return (
    <div style={vt(`s-${s.id}`)} className="flex gap-2">
      {cell}
      <article
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => e.key === "Enter" && onOpen()}
        className="glow-needs relative flex min-w-0 flex-1 cursor-pointer border border-needs bg-black/85 hover:bg-code-dark/30"
      >
        <div className="pulse w-2 shrink-0 bg-needs" />
        <div className="min-w-0 flex-1 p-2">
          <div className="flex items-baseline justify-between gap-4 text-xs">
            <span className="min-w-0 truncate" title={s.cwd}>
              <span className="font-bold">{repoName(s)}</span>
              {s.branch && <span className="text-code-dim"> {s.branch}</span>}
              {sessionName(s) && <span className="text-code-dim"> · {sessionName(s)}</span>}
              {s.topic && <span className="text-code-dim"> · now: {s.topic}</span>}
            </span>
            <span className="flex shrink-0 items-baseline gap-2 text-code-dim">
              {ago(s.lastActivity, now)} ago
              <PauseMenu ids={[s.id]} />
              <TermButton s={s} />
            </span>
          </div>
          <RefList refs={focus.own} className="mt-1" />
          {pending.length > 0 ? (
            // Its approvals and questions are the next step, answerable right here.
            <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              {pending.map((p) => (
                <PendingCard key={p.id} p={p} now={now} inline onDecide={(b, x) => onDecide(p.id, b, x)} />
              ))}
            </div>
          ) : (
            <p className="mt-1 text-lg font-bold text-needs [text-shadow:0_0_6px_rgb(255_176_0/0.7)]">
              {"→ "}
              {action ? <WithCode text={action} s={s} /> : <span className="cursor text-code-dim">decoding next step</span>}
            </p>
          )}
          {s.nextUrl && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {s.nextUrl && (
                <a
                  href={s.nextUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="border border-needs px-2 font-bold text-needs hover:bg-needs hover:text-black hover:[text-shadow:none]"
                >
                  open {s.nextUrl.replace(/^https?:\/\//, "")} ↗
                </a>
              )}
            </div>
          )}
          {s.lastReply && (
            <p className="mt-1 truncate text-xs text-code-dim" title={s.lastReply}>
              claude: {s.lastReply}
            </p>
          )}
          {s.live && pending.length === 0 && <ReplyBox sessionId={s.id} says={s.nextSays} onSent={onSent} />}
        </div>
        <Leaving to={leaving} />
      </article>
    </div>
  );
}

function SessionTable({
  name,
  sessions,
  now,
  leaving,
  onOpen,
  sort,
  ctx,
}: {
  name: string;
  sessions: Session[];
  now: number;
  leaving: Map<string, string>;
  onOpen: (id: string) => void;
  sort: Sort;
  ctx: SortCtx;
}) {
  // One grid row per session, so each cell shares its row's height. The table's border and glow
  // are a box behind the rows' column.
  const n = sessions.length;
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-x-2 sm:grid-cols-[7rem_1fr]">
      <div style={{ ...vt(`t-${name}`), gridColumn: 2, gridRow: `1 / span ${n}` }} className={`${BORDER} glow bg-black/85`} />
      {sessions.map((s, i) => {
        const value = rowCell(s, sort, ctx);
        return (
          <Fragment key={s.id}>
            <div
              style={{ ...vt(`c-${name}-${s.id}`), gridColumn: 1, gridRow: i + 1 }}
              className="self-center truncate text-xs leading-tight text-code-dim"
              title={`${sort.def.label}: ${value}`}
            >
              {value}
            </div>
            <div
              style={{ gridColumn: 2, gridRow: i + 1 }}
              className={`mx-px min-w-0 ${i === 0 ? "mt-px" : "border-t border-code-dark"} ${i === n - 1 ? "mb-px" : ""}`}
            >
              <SessionRow s={s} now={now} leaving={leaving.get(s.id)} onOpen={() => onOpen(s.id)} />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export function App() {
  const { state, offline, refresh } = useOperatorState();
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);
  const [query, setQuery] = useState("");
  const filterBox = useRef<HTMLInputElement>(null);

  // "/" jumps to the filter, like most lists that have one. "o" jumps to the operator.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as Element | null)?.closest?.("input, textarea, [contenteditable]");
      if (typing || openId || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        filterBox.current?.focus();
      } else if (e.key === "o") {
        const box = document.getElementById(OPERATOR_INPUT);
        if (!box) return;
        e.preventDefault();
        box.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  const decide = async (id: string, behavior: Behavior, extra?: DecideExtra) => {
    const res = await fetch(`/api/decisions/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behavior, ...extra }),
    }).catch(() => null);
    void refresh();
    return res?.ok ?? false;
  };

  // Sessions and approvals you just answered. Dropped once the server agrees they've moved, or
  // after a while if it never does (then the row moves back).
  const [sent, setSent] = useState(new Set<string>());
  const markSent = useCallback((id: string) => {
    setSent((cur) => new Set(cur).add(id));
    setTimeout(() => setSent((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    }), 10_000);
  }, []);

  // The header, operator strip and panel are pinned, so they stay live. The list below holds
  // still while you're aiming at it.
  const listRef = useRef<HTMLDivElement>(null);
  // The filter narrows what's listed; the tab icon, counts and lone approvals still see everyone.
  const { all, operators, everyone, sessions, pending, approvals, allGroups, pausedCount } = sortState(state, query);
  const openSession = all.find((s) => s.id === openId);
  // No animation behind the panel: the snapshots would draw over it.
  const answered = useMemo(() => withSent(state, sent), [state, sent]);
  const { shown, leaving } = useCalmState(answered, listRef, !openId);
  const list = sortState(shown, query);
  useEffect(() => {
    const at = state ? placements(state) : new Map<string, string>();
    setSent((cur) => {
      const next = new Set([...cur].filter((id) => at.get(id) === "needs" || at.get(id) === "approve"));
      return next.size === cur.size ? cur : next;
    });
  }, [state]);
  const pendingFor = (id: string) => list.pending.filter((p) => p.sessionId === id);
  const [sort, pickSort, flipSort] = useSort();
  const ctx: SortCtx = { now, pendingFor };
  const sorted = (rows: Session[]) => sortRows(rows, sort, ctx);
  // The sort control sits on the first open group's header line, right above the column.
  const sortControl = <SortControl sort={sort} onPick={pickSort} onFlip={flipSort} />;
  const firstHeader = list.approvals.length > 0 ? "approve" : list.groups.find((g) => g.rows.length > 0)?.key;
  const nothingActive =
    shown && list.approvals.length === 0 && list.paused.length === 0 && list.groups.every((g) => g.rows.length === 0);
  // The tab icon goes amber, and the title counts, while anything waits on you.
  const needsCount =
    (allGroups.find((g) => g.key === "needs")?.rows.length ?? 0) +
    approvals.length +
    operators.filter((s) => s.status === "waiting" || pending.some((p) => p.sessionId === s.id)).length;
  useEffect(() => setFavicon(needsCount), [needsCount]);

  return (
    <main className="mx-auto max-w-6xl px-4 pb-4">
      <MatrixRain />
      {/* Named so rows mid-transition stay under it, not drawn on top. */}
      <div style={vt("deck-header")} className="sticky top-0 z-20 bg-black pb-2 pt-4">
        <header className={`${BORDER} glow flex items-baseline justify-between bg-black/85 px-2 py-1`}>
          <h1 className="cursor shrink-0 text-sm font-bold uppercase tracking-widest">Session operator</h1>
          <input
            ref={filterBox}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.stopPropagation();
              setQuery("");
              e.currentTarget.blur();
            }}
            placeholder="/ filter: name, topic, branch, card, what you said"
            className="mx-4 min-w-0 flex-1 border-b border-code-dark bg-transparent px-1 text-xs text-white caret-code outline-none placeholder:text-code-dark focus:border-code"
          />
          {offline ? (
            <span className="pulse shrink-0 bg-fail px-2 text-xs font-bold uppercase text-black [text-shadow:none]">connection lost</span>
          ) : (
            <span className="shrink-0 text-xs text-code-dim">
              {query ? `${sessions.length} of ${everyone.length} match` : `${everyone.length} signals in the matrix`}
            </span>
          )}
        </header>
        {operators.map((s) => (
          <OperatorConsole
            key={s.id}
            s={s}
            now={now}
            pending={pending.filter((p) => p.sessionId === s.id)}
            tally={[
              ...allGroups.filter((g) => g.rows.length > 0).map((g) => ({ title: g.title, count: g.rows.length, color: g.color })),
              ...(pausedCount > 0 ? [{ title: "Paused", count: pausedCount, color: "border border-code-dim" }] : []),
            ]}
            onOpen={() => setOpenId(s.id)}
            onDecide={(id, b, a) => void decide(id, b, a)}
          />
        ))}
        {state && operators.length === 0 && (
          <p className="mt-2 border border-dashed border-code-dim px-2 py-1 text-xs text-code-dim">
            no operator running - start one with <code className="bg-code-dark px-1 text-white">sop operator</code>
          </p>
        )}
      </div>

      <div ref={listRef}>
        {!firstHeader && (
          <div className="mt-6 flex">
            <div className={GUTTER}>{sortControl}</div>
          </div>
        )}
        {list.approvals.length > 0 && (
          <section className="mt-6">
            <GroupHeader name="approve" title="Approve?" count={list.approvals.length} color="bg-needs" lead={sortControl} />
            <div className="space-y-2">
              {list.approvals.map((p) => (
                <div key={p.id} style={vt(`p-${p.id}`)} className="relative flex gap-2">
                  <div className={`${GUTTER} pt-2`}>
                    <EffortBars effort={p.effort} />
                  </div>
                  <PendingCard
                    p={p}
                    now={now}
                    onDecide={(b, a) => void decide(p.id, b, a).then((ok) => ok && markSent(p.id))}
                  />
                  <Leaving to={leaving.get(p.id)} />
                </div>
              ))}
            </div>
          </section>
        )}

        {list.groups
          .filter((g) => g.rows.length > 0)
          .map((g) => (
            <section key={g.key} className="mt-6">
              <GroupHeader
                name={g.key}
                title={g.title}
                count={g.rows.length}
                color={g.color}
                lead={firstHeader === g.key && sortControl}
              >
                {g.key === "needs" && g.rows.length > 1 && (
                  <PauseMenu ids={g.rows.map((s) => s.id)} label={query ? `pause these ${g.rows.length}` : "pause all"} />
                )}
              </GroupHeader>
              {g.key === "needs" ? (
                <div className="space-y-2">
                  {sorted(g.rows).map((s) => (
                    <NeedsYouCard
                      key={s.id}
                      cell={<NeedsCell s={s} sort={sort} ctx={ctx} />}
                      s={s}
                      now={now}
                      pending={pendingFor(s.id)}
                      leaving={leaving.get(s.id)}
                      onOpen={() => setOpenId(s.id)}
                      // Its last approval answered, it goes back to work.
                      onDecide={(id, b, x) =>
                        void decide(id, b, x).then((ok) => ok && pendingFor(s.id).length === 1 && markSent(s.id))
                      }
                      onSent={() => markSent(s.id)}
                    />
                  ))}
                </div>
              ) : (
                <SessionTable name={g.key} sessions={sorted(g.rows)} now={now} leaving={leaving} onOpen={setOpenId} sort={sort} ctx={ctx} />
              )}
            </section>
          ))}

        {query && list.sessions.length === 0 ? (
          <p style={vt("empty")} className={`${BORDER} mt-6 border-dashed bg-black/85 p-3 text-center text-sm`}>no session matches "{query}"</p>
        ) : (
          nothingActive && (
            <p style={vt("empty")} className={`${BORDER} mt-6 border-dashed bg-black/85 p-3 text-center text-sm`}>wake up... nothing is running</p>
          )
        )}

        {list.paused.length > 0 && (
          <details className="mt-6">
            <summary style={vt("g-paused")} className={`${PAST_GUTTER} mb-1 cursor-pointer text-xs font-bold uppercase tracking-widest text-code-dim`}>
              <span className="mr-2 inline-block h-2.5 w-2.5 border border-code-dim align-middle" />
              Paused [{list.paused.length}]
            </summary>
            <SessionTable name="paused" sessions={sorted(list.paused)} now={now} leaving={leaving} onOpen={setOpenId} sort={sort} ctx={ctx} />
          </details>
        )}

        {list.idle.length > 0 && (
          <details className="mt-6">
            <summary style={vt("g-idle")} className={`${PAST_GUTTER} mb-1 cursor-pointer text-xs font-bold uppercase tracking-widest text-code-dim`}>
              <span className="mr-2 inline-block h-2.5 w-2.5 bg-code-dark align-middle" />
              Idle [{list.idle.length}]
            </summary>
            <SessionTable name="idle" sessions={sorted(list.idle)} now={now} leaving={leaving} onOpen={setOpenId} sort={sort} ctx={ctx} />
          </details>
        )}

        {list.closed.length > 0 && (
          <details className="mt-4">
            <summary style={vt("g-closed")} className={`${PAST_GUTTER} mb-1 cursor-pointer text-xs font-bold uppercase tracking-widest text-code-dim`}>
              <span className="mr-2 inline-block h-2.5 w-2.5 border border-code-dim align-middle" />
              Closed, last 24h [{list.closed.length}]
            </summary>
            <SessionTable name="closed" sessions={sorted(list.closed)} now={now} leaving={leaving} onOpen={setOpenId} sort={sort} ctx={ctx} />
          </details>
        )}
      </div>

      {openSession && (
        <SessionDetail
          key={openSession.id}
          session={openSession}
          onClose={close}
          decisions={pending
            .filter((p) => p.sessionId === openSession.id)
            .map((p) => (
              <PendingCard key={p.id} p={p} now={now} onDecide={(b, a) => void decide(p.id, b, a)} />
            ))}
        />
      )}
    </main>
  );
}
