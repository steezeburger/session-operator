import { useCallback, useEffect, useState } from "react";
import type { Behavior, DeckState, PendingDecision, Ref, Session, SessionStatus } from "../../server/types.ts";
import { MatrixRain } from "./MatrixRain.tsx";
import { focusRefs, MetaTag, RefList, refLabel, WithMentions } from "./Refs.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { SessionDetail } from "./SessionDetail.tsx";

// Six meanings only: amber = needs Jesse, red = failing, cyan = waiting on the world (CI, deploy),
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

function useDeckState() {
  const [state, setState] = useState<DeckState | null>(null);
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

function PendingCard({ p, now, onDecide }: { p: PendingDecision; now: number; onDecide: (b: Behavior) => void }) {
  const left = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - now) / 1000));
  const input = JSON.stringify(p.toolInput, null, 2);
  const project = p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
  return (
    <article className="glow-needs flex border border-needs bg-black/85">
      <div className="w-2 shrink-0 bg-needs pulse" />
      <div className="min-w-0 flex-1 p-2">
        <div className="flex items-baseline justify-between gap-4 text-xs uppercase text-needs [text-shadow:0_0_4px_rgb(255_176_0/0.6)]">
          <span className="font-bold">
            {project} → {p.toolName}
          </span>
          <span>terminal fallback {left}s</span>
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all border border-code-dark bg-code-dark/40 px-2 py-1 text-xs">
          {p.summary}
        </pre>
        {input && input !== JSON.stringify(p.summary) && (
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer uppercase text-code-dim">Full tool input</summary>
            <pre className={`${BORDER} mt-1 max-h-64 overflow-auto p-2`}>{input}</pre>
          </details>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide("allow")}
            className="border border-code bg-code px-5 py-1 text-sm font-bold uppercase text-black [text-shadow:none] hover:bg-black hover:text-code hover:[text-shadow:0_0_4px_rgb(0_255_65/0.6)]"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDecide("deny")}
            className="border border-fail bg-fail px-5 py-1 text-sm font-bold uppercase text-black [text-shadow:none] hover:bg-black hover:text-fail"
          >
            Deny
          </button>
          <span className="ml-2 truncate text-xs text-code-dim">{p.cwd}</span>
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
  const { own: refs, meta } = focusRefs(s);
  const next =
    s.status === "blocked" ? (s.blockedOn ?? "-") : s.status === "waiting" || s.status === "failing" ? s.statusDetail : style.next;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full cursor-pointer grid-cols-[5.5rem_1fr_2.5rem] items-stretch text-left text-xs leading-tight hover:bg-code-dark/50 md:grid-cols-[5.5rem_15rem_1fr_14rem_2.5rem]"
    >
      <div className={`px-1.5 py-0.5 font-bold ${style.block}`}>{style.label}</div>
      <div className="min-w-0 truncate px-1.5 py-0.5" title={`${s.cwd}${s.branch ? ` (${s.branch})` : ""}`}>
        <span className="font-bold">{repoName(s)}</span>
        {refs.length > 0 ? (
          <span className="text-white"> {refs.map(refLabel).join(" · ")}</span>
        ) : meta ? (
          <>
            {" "}
            <MetaTag />
          </>
        ) : (
          s.branch && <span className="text-code-dim"> {s.branch}</span>
        )}
      </div>
      <div className="hidden min-w-0 truncate px-1.5 py-0.5 md:block" title={refs[0]?.title ?? s.lastPrompt ?? undefined}>
        {refs[0]?.title ?? s.title ?? "-"}
      </div>
      <div
        className={`hidden truncate px-1.5 py-0.5 font-bold uppercase md:block ${s.status === "blocked" ? "text-blocked [text-shadow:0_0_4px_rgb(0_229_255/0.6)]" : ""}`}
        title={next}
      >
        {next}
      </div>
      <div className="px-1.5 py-0.5 text-right text-code-dim">{ago(s.lastActivity, now)}</div>
    </button>
  );
}

// One imperative line per "needs you" session: what Jesse does next, not what Claude did.
function nextStep(s: Session, pending: PendingDecision | undefined): string {
  if (pending) return `Approve or deny ${pending.toolName} above: ${pending.summary}`;
  if (s.status === "waiting") return `In its terminal: ${s.statusDetail}`;
  if (s.nextAction) return s.nextAction;
  return s.nextLoading ? "" : "No clear ask - open it to see the last message";
}

// `code` spans from Claude's text, shown as bright chips so commands stand out.
function WithCode({ text, refs = [] }: { text: string; refs?: Ref[] }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="bg-code-dark px-1 normal-case text-white [text-shadow:0_0_4px_rgb(214_255_223/0.6)]">
            {part.slice(1, -1)}
          </code>
        ) : (
          <WithMentions key={i} text={part} refs={refs} />
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
}: { s: Session; now: number; pending: PendingDecision | undefined; onOpen: () => void }) {
  const action = nextStep(s, pending);
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
            {focus.meta && (
              <>
                {" "}
                <MetaTag />
              </>
            )}
            {s.title && <span className="text-code-dim"> · {s.title}</span>}
          </span>
          <span className="shrink-0 text-code-dim">{ago(s.lastActivity, now)} ago</span>
        </div>
        <RefList refs={focus.own} className="mt-1" />
        <p className="mt-1 text-lg font-bold text-needs [text-shadow:0_0_6px_rgb(255_176_0/0.7)]">
          {"→ "}
          {action ? <WithCode text={action} refs={s.refs} /> : <span className="cursor text-code-dim">decoding next step</span>}
        </p>
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
        {s.live && !pending && <ReplyBox sessionId={s.id} say={s.nextSay} />}
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
  const { state, offline, refresh } = useDeckState();
  const now = useNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const close = useCallback(() => setOpenId(null), []);

  const decide = async (id: string, behavior: Behavior) => {
    await fetch(`/api/decisions/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behavior }),
    });
    void refresh();
  };

  const sessions = state?.sessions ?? [];
  const idle = sessions.filter((s) => s.status === "idle");
  const closed = sessions.filter((s) => s.status === "closed");
  const pending = state?.pending ?? [];
  const openSession = sessions.find((s) => s.id === openId);
  const pendingBySession = new Map(pending.map((p) => [p.sessionId, p]));
  const groups = GROUPS.map((g) => ({ ...g, rows: sessions.filter((s) => g.statuses.includes(s.status)) }));
  const nothingActive = state && pending.length === 0 && groups.every((g) => g.rows.length === 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-4">
      <MatrixRain />
      <header className={`${BORDER} glow flex items-baseline justify-between bg-black/85 px-2 py-1`}>
        <h1 className="cursor text-sm font-bold uppercase tracking-widest">Session deck</h1>
        {offline ? (
          <span className="pulse bg-fail px-2 text-xs font-bold uppercase text-black [text-shadow:none]">connection lost</span>
        ) : (
          <span className="text-xs text-code-dim">{sessions.length} signals in the matrix</span>
        )}
      </header>

      {pending.length > 0 && (
        <section className="mt-6">
          <GroupHeader title="Approve?" count={pending.length} color="bg-needs" />
          <div className="space-y-2">
            {pending.map((p) => (
              <PendingCard key={p.id} p={p} now={now} onDecide={(b) => void decide(p.id, b)} />
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
                    pending={pendingBySession.get(s.id)}
                    onOpen={() => setOpenId(s.id)}
                  />
                ))}
              </div>
            ) : (
              <SessionTable sessions={g.rows} now={now} onOpen={setOpenId} />
            )}
          </section>
        ))}

      {nothingActive && (
        <p className={`${BORDER} mt-6 border-dashed bg-black/85 p-3 text-center text-sm`}>wake up, jesse... nothing is running</p>
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

      {openSession && <SessionDetail session={openSession} onClose={close} />}
    </main>
  );
}
