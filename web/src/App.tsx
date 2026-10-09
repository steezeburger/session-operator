import { useCallback, useEffect, useState } from "react";
import type { Behavior, DeckState, PendingDecision, Session, SessionStatus } from "../../server/types.ts";

// Four meanings only: orange = needs Jesse, red = failing, green = running, gray = idle.
const NEEDS_YOU = "bg-orange-500 text-black";
const STATUS_STYLE: Record<SessionStatus, { label: string; block: string; next: string }> = {
  waiting: { label: "NEEDS YOU", block: NEEDS_YOU, next: "Answer it" },
  done: { label: "YOUR MOVE", block: NEEDS_YOU, next: "Read + reply" },
  failing: { label: "FAILING", block: "bg-red-600 text-white", next: "Check on it" },
  working: { label: "WORKING", block: "bg-green-600 text-white", next: "Let it run" },
  idle: { label: "IDLE", block: "bg-stone-400 text-black dark:bg-stone-600 dark:text-white", next: "-" },
};

const GROUPS: { key: string; title: string; statuses: SessionStatus[]; color: string }[] = [
  { key: "needs", title: "Needs you", statuses: ["waiting", "done"], color: "bg-orange-500" },
  { key: "failing", title: "Failing", statuses: ["failing"], color: "bg-red-600" },
  { key: "working", title: "Working", statuses: ["working"], color: "bg-green-600" },
];

const BORDER = "border-2 border-black dark:border-white";

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
      {title} [{count}]
    </h2>
  );
}

function PendingCard({ p, now, onDecide }: { p: PendingDecision; now: number; onDecide: (b: Behavior) => void }) {
  const left = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - now) / 1000));
  const input = JSON.stringify(p.toolInput, null, 2);
  const project = p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
  return (
    <article className={`${BORDER} flex bg-white dark:bg-black`}>
      <div className="w-2 shrink-0 bg-orange-500" />
      <div className="min-w-0 flex-1 p-2">
        <div className="flex items-baseline justify-between gap-4 text-xs uppercase">
          <span className="font-bold">
            {project} → {p.toolName}
          </span>
          <span>terminal fallback {left}s</span>
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all bg-black px-2 py-1 text-xs text-white dark:bg-white dark:text-black">
          {p.summary}
        </pre>
        {input && input !== JSON.stringify(p.summary) && (
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer uppercase">Full tool input</summary>
            <pre className={`${BORDER} mt-1 max-h-64 overflow-auto p-2`}>{input}</pre>
          </details>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDecide("allow")}
            className={`${BORDER} bg-green-600 px-5 py-1 text-sm font-bold uppercase text-white hover:bg-green-700`}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDecide("deny")}
            className={`${BORDER} bg-red-600 px-5 py-1 text-sm font-bold uppercase text-white hover:bg-red-700`}
          >
            Deny
          </button>
          <span className="ml-2 truncate text-xs opacity-60">{p.cwd}</span>
        </div>
      </div>
    </article>
  );
}

function SessionRow({ s, now }: { s: Session; now: number }) {
  const style = STATUS_STYLE[s.status];
  const next = s.status === "waiting" || s.status === "failing" ? s.statusDetail : style.next;
  return (
    <div className="grid grid-cols-[5.5rem_1fr_2.5rem] items-stretch text-xs leading-tight md:grid-cols-[5.5rem_16rem_1fr_10rem_2.5rem]">
      <div className={`px-1.5 py-0.5 font-bold ${style.block}`}>{style.label}</div>
      <div className="min-w-0 truncate px-1.5 py-0.5" title={s.cwd}>
        <span className="font-bold">{s.project}</span>
        {s.branch && <span className="opacity-60"> {s.branch}</span>}
      </div>
      <div className="hidden min-w-0 truncate px-1.5 py-0.5 md:block" title={s.lastPrompt ?? undefined}>
        {s.title ?? "-"}
      </div>
      <div className="hidden truncate px-1.5 py-0.5 font-bold uppercase md:block">{next}</div>
      <div className="px-1.5 py-0.5 text-right">{ago(s.lastActivity, now)}</div>
    </div>
  );
}

function SessionTable({ sessions, now }: { sessions: Session[]; now: number }) {
  return (
    <div className={`${BORDER} divide-y divide-black bg-white dark:divide-white dark:bg-black`}>
      {sessions.map((s) => (
        <SessionRow key={s.id} s={s} now={now} />
      ))}
    </div>
  );
}

export function App() {
  const { state, offline, refresh } = useDeckState();
  const now = useNow();

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
  const pending = state?.pending ?? [];
  const groups = GROUPS.map((g) => ({ ...g, rows: sessions.filter((s) => g.statuses.includes(s.status)) }));
  const nothingActive = state && pending.length === 0 && groups.every((g) => g.rows.length === 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-4">
      <header className={`${BORDER} flex items-baseline justify-between bg-black px-2 py-1 text-white dark:bg-white dark:text-black`}>
        <h1 className="text-sm font-bold uppercase tracking-widest">Session deck</h1>
        {offline && <span className="bg-red-600 px-2 text-xs font-bold uppercase text-white">server unreachable</span>}
      </header>

      {pending.length > 0 && (
        <section className="mt-6">
          <GroupHeader title="Approve?" count={pending.length} color="bg-orange-500" />
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
            <SessionTable sessions={g.rows} now={now} />
          </section>
        ))}

      {nothingActive && (
        <p className={`${BORDER} mt-6 border-dashed p-3 text-center text-sm uppercase`}>Nothing active</p>
      )}

      {idle.length > 0 && (
        <details className="mt-6">
          <summary className="mb-1 cursor-pointer text-xs font-bold uppercase tracking-widest">
            <span className="mr-2 inline-block h-2.5 w-2.5 bg-stone-400 align-middle dark:bg-stone-600" />
            Idle [{idle.length}]
          </summary>
          <SessionTable sessions={idle} now={now} />
        </details>
      )}
    </main>
  );
}
