import { useEffect, useRef, useState } from "react";
import type { FeedItem, Session } from "../../server/types.ts";
import { closedOutcome, focusRefs, MetaTag, RefList } from "./Refs.tsx";
import { ReplyBox } from "./ReplyBox.tsx";

const KIND_STYLE: Record<FeedItem["kind"], { label: string; cls: string }> = {
  user: { label: "you", cls: "border-code text-white [text-shadow:0_0_4px_rgb(214_255_223/0.5)]" },
  assistant: { label: "claude", cls: "border-code-dim" },
  tool: { label: "tool", cls: "border-code-dark text-code-dim text-xs" },
  error: { label: "error", cls: "border-fail text-fail [text-shadow:0_0_4px_rgb(255_42_42/0.6)]" },
};

function time(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function SessionDetail({ session, onClose }: { session: Session; onClose: () => void }) {
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [missing, setMissing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const focus = focusRefs(session);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/sessions/${session.id}/feed`);
        if (!live) return;
        if (!res.ok) return setMissing(true);
        setFeed(await res.json());
      } catch {
        // offline: the header already says so
      }
    };
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [session.id]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [feed?.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="glow flex h-full w-full flex-col border-l border-code-dim bg-black md:w-[40rem]"
        onClick={(e) => {
          e.stopPropagation();
          // Any click in the panel goes to the reply input, except on controls or while
          // selecting text to copy.
          if ((e.target as Element).closest("a, button, input, summary, details")) return;
          if (window.getSelection()?.toString()) return;
          e.currentTarget.querySelector<HTMLInputElement>("footer input")?.focus();
        }}
        aria-label={`${session.project} session`}
      >
        <header className="relative flex items-start justify-between gap-2 border-b border-code-dim p-2">
          <div className="min-w-0 text-xs">
            <div className="truncate text-sm font-bold">
              {session.project}
              {session.branch && <span className="font-normal text-code-dim"> {session.branch}</span>}
            </div>
            {session.title && <div className="truncate">{session.title}</div>}
            <RefList refs={focus.own} className="my-1" />
            {focus.mentioned.length > 0 && (
              <details className="my-1 text-code-dim">
                <summary className="cursor-pointer">
                  {focus.meta && <MetaTag />} mentioned {focus.mentioned.length}
                </summary>
                <RefList refs={focus.mentioned} className="mt-1 opacity-70" />
              </details>
            )}
            <div className="truncate text-code-dim">
              {session.status === "closed" ? closedOutcome(session).text : session.statusDetail} · {session.cwd}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <div className="flex gap-1">
              {session.live && <EndSessionButton sessionId={session.id} onEnded={onClose} />}
              <button
                type="button"
                onClick={onClose}
                className="border border-code-dim px-2 text-xs uppercase hover:border-code"
              >
                esc
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 space-y-2 overflow-y-auto p-2 text-sm">
          {missing && <p className="text-code-dim">transcript not found</p>}
          {!feed && !missing && <p className="cursor text-code-dim">loading</p>}
          {feed?.map((item, i) => {
            const k = KIND_STYLE[item.kind];
            return (
              <div key={`${item.at}-${i}`} className={`border-l-2 pl-2 ${k.cls}`}>
                <div className="text-[10px] uppercase tracking-widest text-code-dim">
                  {k.label} {time(item.at)}
                </div>
                <div className="whitespace-pre-wrap break-words">{item.text}</div>
              </div>
            );
          })}
          <div ref={bottom} />
        </div>

        <footer className="border-t border-code-dim p-2">
          {session.live ? (
            <ReplyBox sessionId={session.id} say={session.nextSay} autoFocus />
          ) : (
            <p className="text-xs text-code-dim">not running - can't reply from here</p>
          )}
        </footer>
      </aside>
    </div>
  );
}

// Exits Claude and closes its iTerm tab. First click arms it, second click does it.
function EndSessionButton({ sessionId, onEnded }: { sessionId: string; onEnded: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (res.ok) return onEnded();
      setError(((await res.json()) as { error?: string }).error ?? "Close failed");
    } catch {
      setError("Server unreachable");
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => (armed ? void end() : setArmed(true))}
        title="Exit Claude and close its iTerm tab"
        className={`border px-2 text-xs uppercase ${
          armed ? "border-fail bg-fail font-bold text-black [text-shadow:none]" : "border-code-dim text-fail hover:border-fail"
        }`}
      >
        {busy ? "closing..." : armed ? "sure? end it" : "end session"}
      </button>
      {error && <p className="absolute right-2 top-10 max-w-60 text-right text-xs text-fail">{error}</p>}
    </>
  );
}
