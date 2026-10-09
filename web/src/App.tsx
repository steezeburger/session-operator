import { useCallback, useEffect, useState } from "react";
import type { Behavior, DeckState, PendingDecision, Session, SessionStatus } from "../../server/types.ts";

const STATUS_STYLE: Record<SessionStatus, { label: string; dot: string; pill: string; next: string }> = {
  waiting: {
    label: "Needs you",
    dot: "bg-amber-500",
    pill: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
    next: "Answer it here or in the terminal",
  },
  done: {
    label: "Your move",
    dot: "bg-emerald-500",
    pill: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300",
    next: "Read the result and reply",
  },
  working: {
    label: "Working",
    dot: "bg-sky-500 animate-pulse",
    pill: "bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-300",
    next: "Nothing to do, let it run",
  },
  idle: {
    label: "Idle",
    dot: "bg-stone-400",
    pill: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-400",
    next: "Nothing to do",
  },
};

function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
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

function PendingCard({ p, now, onDecide }: { p: PendingDecision; now: number; onDecide: (b: Behavior) => void }) {
  const left = Math.max(0, Math.round((new Date(p.expiresAt).getTime() - now) / 1000));
  const input = JSON.stringify(p.toolInput, null, 2);
  const project = p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
  return (
    <article className="rounded-2xl border-2 border-amber-400 bg-white p-6 shadow-sm dark:border-amber-500/60 dark:bg-stone-900">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-lg font-semibold">
          {project} wants to run <span className="font-mono">{p.toolName}</span>
        </h3>
        <span className="shrink-0 text-sm text-stone-500">falls back to terminal in {left}s</span>
      </div>
      <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-stone-100 p-4 font-mono text-sm dark:bg-stone-800">
        {p.summary}
      </pre>
      {input && input !== JSON.stringify(p.summary) && (
        <details className="mt-3 text-sm text-stone-500">
          <summary className="cursor-pointer">Full tool input</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-stone-100 p-4 font-mono text-xs dark:bg-stone-800">
            {input}
          </pre>
        </details>
      )}
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={() => onDecide("allow")}
          className="rounded-lg bg-emerald-600 px-6 py-2.5 font-medium text-white hover:bg-emerald-700"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onDecide("deny")}
          className="rounded-lg border border-stone-300 px-6 py-2.5 font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
        >
          Deny
        </button>
      </div>
      <p className="mt-3 text-xs text-stone-500">{p.cwd}</p>
    </article>
  );
}

function SessionCard({ s, now }: { s: Session; now: number }) {
  const style = STATUS_STYLE[s.status];
  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-6 dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-semibold">{s.title ?? s.project}</h3>
          <p className="truncate text-sm text-stone-500">
            {s.project}
            {s.branch && <span className="font-mono"> · {s.branch}</span>}
          </p>
        </div>
        <span className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${style.pill}`}>
          <span className={`h-2 w-2 rounded-full ${style.dot}`} />
          {style.label}
        </span>
      </div>
      {s.lastPrompt && <p className="mt-4 line-clamp-2 text-stone-600 dark:text-stone-400">“{s.lastPrompt}”</p>}
      <div className="mt-4 flex items-baseline justify-between gap-4 text-sm">
        <span className="font-medium">→ {s.status === "waiting" ? s.statusDetail : style.next}</span>
        <span className="shrink-0 text-stone-500">{ago(s.lastActivity, now)}</span>
      </div>
    </article>
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
  const active = sessions.filter((s) => s.status !== "idle");
  const idle = sessions.filter((s) => s.status === "idle");
  const pending = state?.pending ?? [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Session deck</h1>
        {offline && <span className="text-sm text-amber-600">server unreachable</span>}
      </header>

      {pending.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-amber-600">
            Waiting on you ({pending.length})
          </h2>
          <div className="space-y-6">
            {pending.map((p) => (
              <PendingCard key={p.id} p={p} now={now} onDecide={(b) => void decide(p.id, b)} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-12">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-stone-500">Sessions</h2>
        {state && active.length === 0 && (
          <p className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-stone-500 dark:border-stone-700">
            Nothing active. Calm seas.
          </p>
        )}
        <div className="space-y-6">
          {active.map((s) => (
            <SessionCard key={s.id} s={s} now={now} />
          ))}
        </div>
      </section>

      {idle.length > 0 && (
        <details className="mt-12">
          <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-stone-500">
            Idle ({idle.length})
          </summary>
          <div className="mt-4 space-y-6 opacity-70">
            {idle.map((s) => (
              <SessionCard key={s.id} s={s} now={now} />
            ))}
          </div>
        </details>
      )}
    </main>
  );
}
