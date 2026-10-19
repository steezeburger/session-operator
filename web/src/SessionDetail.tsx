import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FeedItem, Session } from "../../server/types.ts";
import { closedOutcome, focusRefs, RefList } from "./Refs.tsx";
import { imageFiles, ReplyBox } from "./ReplyBox.tsx";

const KIND_STYLE: Record<FeedItem["kind"], { label: string; cls: string }> = {
  user: { label: "you", cls: "border-code text-white [text-shadow:0_0_4px_rgb(214_255_223/0.5)]" },
  assistant: { label: "claude", cls: "border-code-dim" },
  tool: { label: "tool", cls: "border-code-dark text-code-dim text-xs" },
  error: { label: "error", cls: "border-fail text-fail [text-shadow:0_0_4px_rgb(255_42_42/0.6)]" },
};

const WIDTH_KEY = "deck.panelWidth";
const MIN_WIDTH = 360;

function savedWidth() {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w >= MIN_WIDTH) return w;
  } catch {
    // storage blocked: use the default
  }
  return 640;
}

const URL_RE = /(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?])/g;

function Linkified({ text }: { text: string }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="text-white underline decoration-code-dim underline-offset-2 hover:decoration-code">
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

function time(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

const FEED_PAGE = 40;

export function SessionDetail({ session, onClose }: { session: Session; onClose: () => void }) {
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(FEED_PAGE);
  const [missing, setMissing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Scroll height before "load earlier", so the view stays put when older items land on top.
  const keepFrom = useRef<number | null>(null);
  const focus = focusRefs(session);
  const [width, setWidth] = useState(savedWidth);
  const resizing = useRef(false);
  // Images dropped anywhere on the panel wait in the reply box.
  const images = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);

  // Drag the panel's left edge; the width sticks for next time.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const clamp = (x: number) => Math.min(window.innerWidth - 80, Math.max(MIN_WIDTH, window.innerWidth - x));
    let last = width;
    resizing.current = true;
    const move = (ev: PointerEvent) => {
      last = clamp(ev.clientX);
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      // The click that ends a drag lands on the backdrop; don't let it close the panel.
      setTimeout(() => {
        resizing.current = false;
      });
      try {
        localStorage.setItem(WIDTH_KEY, String(last));
      } catch {
        // storage blocked: width just won't stick
      }
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/sessions/${session.id}/feed?limit=${limit}`);
        if (!live) return;
        if (!res.ok) return setMissing(true);
        setTotal(Number(res.headers.get("X-Feed-Total")) || 0);
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
  }, [session.id, limit]);

  // New messages scroll to the bottom; older ones loaded on top keep the view where it was.
  const newest = feed?.length ? `${feed.length}-${feed[feed.length - 1]?.at}` : "";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && keepFrom.current !== null) {
      el.scrollTop += el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
      return;
    }
    bottom.current?.scrollIntoView({ block: "end" });
  }, [newest]);

  const loadEarlier = () => {
    keepFrom.current = scroller.current?.scrollHeight ?? null;
    setLimit((l) => l + FEED_PAGE);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/60" onClick={() => !resizing.current && onClose()}>
      <aside
        className="glow relative flex h-full w-full flex-col border-l border-code-dim bg-black md:w-[var(--panel-w)]"
        style={{ "--panel-w": `${width}px` } as CSSProperties}
        onClick={(e) => {
          e.stopPropagation();
          // Any click in the panel goes to the reply input, except on controls or while
          // selecting text to copy.
          if ((e.target as Element).closest("a, button, input, textarea, summary, details, [data-resize]")) return;
          if (window.getSelection()?.toString()) return;
          e.currentTarget.querySelector<HTMLTextAreaElement>("footer textarea")?.focus();
        }}
        aria-label={`${session.project} session`}
        onDragOver={(e) => {
          if (!session.live || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!session.live) return;
          const files = imageFiles(e.dataTransfer.files);
          if (files.length > 0) images[1]((prev) => [...prev, ...files]);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-code bg-black/80 text-sm font-bold uppercase tracking-widest">
            drop image to attach
          </div>
        )}
        <div
          data-resize
          title="Drag to resize"
          onPointerDown={startResize}
          className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize hover:bg-code/40 md:block"
        />
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
                  mentioned {focus.mentioned.length}
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

        <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto p-2 text-sm">
          {missing && <p className="text-code-dim">transcript not found</p>}
          {feed && total > feed.length && (
            <button
              type="button"
              onClick={loadEarlier}
              className="w-full border border-dashed border-code-dim py-1 text-xs uppercase text-code-dim hover:border-code hover:text-code"
            >
              load earlier ({total - feed.length} more)
            </button>
          )}
          {!feed && !missing && <p className="cursor text-code-dim">loading</p>}
          {feed?.map((item, i) => {
            const k = KIND_STYLE[item.kind];
            return (
              <div key={`${item.at}-${i}`} className={`border-l-2 pl-2 ${k.cls}`}>
                <div className="text-[10px] uppercase tracking-widest text-code-dim">
                  {k.label} {time(item.at)}
                </div>
                <div className="whitespace-pre-wrap break-words">
                  <Linkified text={item.text} />
                </div>
              </div>
            );
          })}
          <div ref={bottom} />
        </div>

        <footer className="border-t border-code-dim p-2">
          {session.live ? (
            <ReplyBox sessionId={session.id} say={session.nextSay} autoFocus images={images} />
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
