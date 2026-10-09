import { useEffect, useRef, useState } from "react";
import type { FeedItem, Session } from "../../server/types.ts";
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
        onClick={(e) => e.stopPropagation()}
        aria-label={`${session.project} session`}
      >
        <header className="flex items-start justify-between gap-2 border-b border-code-dim p-2">
          <div className="min-w-0 text-xs">
            <div className="truncate text-sm font-bold">
              {session.project}
              {session.branch && <span className="font-normal text-code-dim"> {session.branch}</span>}
            </div>
            {session.title && <div className="truncate">{session.title}</div>}
            <div className="truncate text-code-dim">
              {session.statusDetail} · {session.cwd}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 border border-code-dim px-2 text-xs uppercase hover:border-code"
          >
            esc
          </button>
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
