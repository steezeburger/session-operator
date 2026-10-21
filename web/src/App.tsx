import { useCallback, useEffect, useRef, useState } from "react";
import type { Behavior, OperatorState, PendingDecision, PermissionUpdate, Session, SessionStatus } from "../../server/types.ts";
import { setFavicon } from "./favicon.ts";
import { MatrixRain } from "./MatrixRain.tsx";
import { closedOutcome, focusRefs, RefLink, RefList, sessionMatches, sessionName } from "./Refs.tsx";
import { WithPaths } from "./Paths.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { SessionDetail } from "./SessionDetail.tsx";

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

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

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
    // Transcripts change without hook events, so poll as well.
    const poll = setInterval(() => void refresh(), 5000);
    return () => {
      events.close();
      clearInterval(poll);
    };
  }, [refresh]);

  return { state, offline, refresh };
}

function GroupHeader({ title, count, color }: { title: string; count: number; color: string }) {
  return (
    <h2 className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-widest">
      <span className={`inline-block h-2.5 w-2.5 ${color}`} />
      {">"} {title} [{count}]
    </h2>
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

// Worktrees live in <repo>/.worktrees/<name>; name the repo, the card says which worktree.
function repoName(s: Session) {
  return s.cwd.match(/\/([^/]+)\/\.worktrees\//)?.[1] ?? s.project;
}

function SessionRow({ s, now, onOpen }: { s: Session; now: number; onOpen: () => void }) {
  const style = STATUS_STYLE[s.status];
  const { own: refs } = focusRefs(s);
  const outcome = s.status === "closed" ? closedOutcome(s) : null;
  const next =
    outcome?.text ??
    (s.status === "blocked" ? (s.blockedOn ?? "-") : s.status === "waiting" || s.status === "failing" ? s.statusDetail : style.next);
  return (
    // A div, not a button: it holds ref links, and links can't nest in a button.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="grid w-full cursor-pointer grid-cols-[5.5rem_1fr_2.5rem] items-stretch text-left text-xs leading-tight hover:bg-code-dark/50 md:grid-cols-[5.5rem_15rem_1fr_14rem_2.5rem]"
    >
      <div className={`px-1.5 py-0.5 font-bold ${style.block}`}>{style.label}</div>
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
    </div>
  );
}

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
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full cursor-pointer items-center gap-2 text-left text-xs hover:bg-code-dark/50"
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
        {line && (
          <button
            type="button"
            onClick={onOpen}
            title={line}
            className={`mt-1 block w-full cursor-pointer truncate text-left text-sm ${waiting ? "font-bold text-needs" : busy ? "text-code-dim" : "text-white"}`}
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
        {pending.length === 0 && <ReplyBox sessionId={s.id} says={s.nextSays} placeholder="tell the operator (shift+enter for a new line)" />}
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
  onOpen,
  onDecide,
}: {
  s: Session;
  now: number;
  pending: PendingDecision[];
  onOpen: () => void;
  onDecide: (id: string, b: Behavior, extra?: DecideExtra) => void;
}) {
  const action = nextStep(s);
  const focus = focusRefs(s);
  return (
    <article
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="glow-needs flex cursor-pointer border border-needs bg-black/85 hover:bg-code-dark/30"
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
          <span className="shrink-0 text-code-dim">{ago(s.lastActivity, now)} ago</span>
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
        {s.live && pending.length === 0 && <ReplyBox sessionId={s.id} says={s.nextSays} />}
      </div>
    </article>
  );
}

function SessionTable({ sessions, now, onOpen }: { sessions: Session[]; now: number; onOpen: (id: string) => void }) {
  return (
    <div className={`${BORDER} glow divide-y divide-code-dark bg-black/85`}>
      {sessions.map((s) => (
        <SessionRow key={s.id} s={s} now={now} onOpen={() => onOpen(s.id)} />
      ))}
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

  // "/" jumps to the filter, like most lists that have one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as Element | null)?.closest?.("input, textarea, [contenteditable]");
      if (e.key === "/" && !typing && !openId) {
        e.preventDefault();
        filterBox.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  const decide = async (id: string, behavior: Behavior, extra?: DecideExtra) => {
    await fetch(`/api/decisions/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behavior, ...extra }),
    });
    void refresh();
  };

  const all = state?.sessions ?? [];
  // The running operator gets its own strip; the rest are the sessions it runs.
  const operators = all.filter((s) => s.role === "operator" && s.live);
  const everyone = all.filter((s) => !operators.includes(s));
  // The filter narrows what's listed; the tab icon and counts still see everyone.
  const sessions = everyone.filter((s) => sessionMatches(s, query));
  const idle = sessions.filter((s) => s.status === "idle");
  const closed = sessions.filter((s) => s.status === "closed");
  const pending = state?.pending ?? [];
  const operatorIds = new Set(operators.map((s) => s.id));
  // Approvals show inside their session's card. Only one whose session isn't listed gets its own.
  const approvals = pending.filter((p) => !operatorIds.has(p.sessionId) && !everyone.some((s) => s.id === p.sessionId));
  const openSession = all.find((s) => s.id === openId);
  const pendingFor = (id: string) => pending.filter((p) => p.sessionId === id);
  const groups = GROUPS.map((g) => ({ ...g, rows: sessions.filter((s) => g.statuses.includes(s.status)) }));
  const allGroups = GROUPS.map((g) => ({ ...g, rows: everyone.filter((s) => g.statuses.includes(s.status)) }));
  const nothingActive = state && approvals.length === 0 && groups.every((g) => g.rows.length === 0);
  // The tab icon goes amber, and the title counts, while anything waits on you.
  const needsCount =
    (allGroups.find((g) => g.key === "needs")?.rows.length ?? 0) +
    approvals.length +
    operators.filter((s) => s.status === "waiting" || pending.some((p) => p.sessionId === s.id)).length;
  useEffect(() => setFavicon(needsCount), [needsCount]);

  return (
    <main className="mx-auto max-w-6xl px-4 pb-4">
      <MatrixRain />
      <div className="sticky top-0 z-20 bg-black pb-2 pt-4">
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
            tally={allGroups.filter((g) => g.rows.length > 0).map((g) => ({ title: g.title, count: g.rows.length, color: g.color }))}
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

      {approvals.length > 0 && (
        <section className="mt-6">
          <GroupHeader title="Approve?" count={approvals.length} color="bg-needs" />
          <div className="space-y-2">
            {approvals.map((p) => (
              <PendingCard key={p.id} p={p} now={now} onDecide={(b, a) => void decide(p.id, b, a)} />
            ))}
          </div>
        </section>
      )}

      {groups
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <section key={g.key} className="mt-6">
            <GroupHeader title={g.title} count={g.rows.length} color={g.color} />
            {g.key === "needs" ? (
              <div className="space-y-2">
                {g.rows.map((s) => (
                  <NeedsYouCard
                    key={s.id}
                    s={s}
                    now={now}
                    pending={pendingFor(s.id)}
                    onOpen={() => setOpenId(s.id)}
                    onDecide={(id, b, x) => void decide(id, b, x)}
                  />
                ))}
              </div>
            ) : (
              <SessionTable sessions={g.rows} now={now} onOpen={setOpenId} />
            )}
          </section>
        ))}

      {query && sessions.length === 0 ? (
        <p className={`${BORDER} mt-6 border-dashed bg-black/85 p-3 text-center text-sm`}>no session matches "{query}"</p>
      ) : (
        nothingActive && !query && (
          <p className={`${BORDER} mt-6 border-dashed bg-black/85 p-3 text-center text-sm`}>wake up... nothing is running</p>
        )
      )}

      {idle.length > 0 && (
        <details className="mt-6">
          <summary className="mb-1 cursor-pointer text-xs font-bold uppercase tracking-widest text-code-dim">
            <span className="mr-2 inline-block h-2.5 w-2.5 bg-code-dark align-middle" />
            Idle [{idle.length}]
          </summary>
          <SessionTable sessions={idle} now={now} onOpen={setOpenId} />
        </details>
      )}

      {closed.length > 0 && (
        <details className="mt-4">
          <summary className="mb-1 cursor-pointer text-xs font-bold uppercase tracking-widest text-code-dim">
            <span className="mr-2 inline-block h-2.5 w-2.5 border border-code-dim align-middle" />
            Closed, last 24h [{closed.length}]
          </summary>
          <SessionTable sessions={closed} now={now} onOpen={setOpenId} />
        </details>
      )}

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
