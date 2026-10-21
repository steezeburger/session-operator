import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CleanupItem, CleanupResult, FeedItem, Session } from "../../server/types.ts";
import { PauseMenu, unpauseSession, untilLabel } from "./Pause.tsx";
import { WithPaths } from "./Paths.tsx";
import { closedOutcome, focusRefs, RefList, sessionName } from "./Refs.tsx";
import { imageFiles, ReplyBox } from "./ReplyBox.tsx";
import { TermButton } from "./TermButton.tsx";

// Three voices, all Matrix: you in white on a faint panel, Claude in full glowing green on
// black, and its tool calls folded into dark-green log blocks with the tool names inverted.
const KIND_STYLE: Record<FeedItem["kind"], { label: string; cls: string; labelCls: string }> = {
  user: { label: "you", cls: "border-white bg-white/5 py-1 text-white [text-shadow:none]", labelCls: "text-white/50" },
  assistant: { label: "claude", cls: "border-code text-code [text-shadow:0_0_6px_rgb(0_255_65/0.6)]", labelCls: "text-code-dim" },
  tool: { label: "tool", cls: "border-tool text-xs text-code-dim [text-shadow:none]", labelCls: "text-tool-dim" },
  error: { label: "error", cls: "border-fail text-fail [text-shadow:0_0_4px_rgb(255_42_42/0.6)]", labelCls: "text-fail/70" },
};

// "Bash: run the tests" -> the tool's name as an inverted chip, then the rest as log text.
function ToolLine({ text }: { text: string }) {
  const at = text.indexOf(": ");
  const name = at < 0 ? text : text.slice(0, at);
  return (
    <>
      <span className="mr-2 bg-tool px-1 text-[10px] font-bold uppercase tracking-wider text-black">{name}</span>
      {at >= 0 && text.slice(at + 2)}
    </>
  );
}

// A run of more than a few tool calls shows as one line of name counts until clicked open.
const TOOLS_SHOWN = 3;
function ToolBlock({ items }: { items: FeedItem[] }) {
  const [open, setOpen] = useState(items.length <= TOOLS_SHOWN);
  const counts = new Map<string, number>();
  for (const t of items) {
    const name = t.text.split(": ")[0] ?? t.text;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (
    <div className={`space-y-0.5 border-l-2 bg-code-dark/40 px-2 py-1 ${KIND_STYLE.tool.cls}`}>
      {open ? (
        <>
          {items.map((t, j) => (
            <div key={j} className="truncate" title={`${t.text}\n${time(t.at)}`}>
              <ToolLine text={t.text} />
            </div>
          ))}
          {items.length > TOOLS_SHOWN && (
            <button type="button" onClick={() => setOpen(false)} className="text-[10px] uppercase tracking-wider hover:text-code">
              fold
            </button>
          )}
        </>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left hover:text-code">
          <span>{items.length} tool calls</span>
          {[...counts].map(([name, c]) => (
            <span key={name} className="bg-tool px-1 text-[10px] font-bold uppercase tracking-wider text-black">
              {name}
              {c > 1 ? ` ×${c}` : ""}
            </span>
          ))}
        </button>
      )}
    </div>
  );
}

// Consecutive tool calls fold into one block, like the terminal's "Ran 5 shell commands".
type FeedRow = { kind: "item"; item: FeedItem; i: number } | { kind: "tools"; items: FeedItem[]; i: number };
function feedRows(feed: FeedItem[]): FeedRow[] {
  const rows: FeedRow[] = [];
  feed.forEach((item, i) => {
    const last = rows.at(-1);
    if (item.kind === "tool" && last?.kind === "tools") last.items.push(item);
    else rows.push(item.kind === "tool" ? { kind: "tools", items: [item], i } : { kind: "item", item, i });
  });
  return rows;
}

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

function Linkified({ text, session }: { text: string; session: Session }) {
  return (
    <>
      {text.split(URL_RE).map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noreferrer" className="text-white underline decoration-code-dim underline-offset-2 hover:decoration-code">
            {part}
          </a>
        ) : (
          <WithPaths key={i} text={part} s={session} />
        ),
      )}
    </>
  );
}

function time(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

const FEED_PAGE = 40;

// `decisions`: the session's pending approvals and questions, rendered by the deck so they
// can be answered here too. While there are any, they take the reply box's place.
export function SessionDetail({ session, onClose, decisions = [] }: { session: Session; onClose: () => void; decisions?: ReactNode[] }) {
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(FEED_PAGE);
  const [missing, setMissing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Scroll height before "load earlier", so the view stays put when older items land on top.
  const keepFrom = useRef<number | null>(null);
  // Follow new messages only while the view sits at the bottom. Scrolled up to read, it
  // stays put and counts what arrived below; scrolling back down (or sending) follows again.
  const following = useRef(true);
  const [seen, setSeen] = useState<FeedItem | null>(null);
  const focus = focusRefs(session);

  // Whether the buttons would squeeze the title, judged by the title text's own width and the
  // buttons' width inline (stacked, they stretch), so moving them doesn't change the answer.
  const titleRow = useRef<HTMLDivElement>(null);
  const titleText = useRef<HTMLSpanElement>(null);
  const buttonsBox = useRef<HTMLDivElement>(null);
  const inlineWidth = useRef(0);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const row = titleRow.current;
      const text = titleText.current;
      const box = buttonsBox.current;
      if (!row || !text || !box) return;
      if (!stacked) inlineWidth.current = box.offsetWidth;
      setStacked(text.offsetWidth + 8 + inlineWidth.current > row.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [titleRow.current, buttonsBox.current]) if (el) observer.observe(el);
    return () => observer.disconnect();
  });

  // Stacked, the buttons are a tab bar: equal parts of the full width, split by thin lines.
  const tab = stacked ? "flex-1 border-l border-code-dark py-1.5 text-xs uppercase first:border-l-0 hover:bg-code-dark/60" : null;
  const buttons = (
    <div ref={buttonsBox} className={stacked ? "relative flex" : "relative flex shrink-0 gap-1"}>
      {session.role !== "operator" &&
        (session.paused ? (
          <button
            type="button"
            onClick={() => void unpauseSession(session.id)}
            title={`Paused ${untilLabel(session)}. Back to its group, nudges and notifications on`}
            className={tab ?? "border border-code px-2 text-xs uppercase hover:bg-code hover:text-black hover:[text-shadow:none]"}
          >
            unpause
          </button>
        ) : (
          session.status !== "closed" && (
            <PauseMenu
              ids={[session.id]}
              className={tab ? "flex-1 border-l border-code-dark first:border-l-0" : ""}
              buttonClass={tab ? "w-full py-1.5 text-xs uppercase hover:bg-code-dark/60" : undefined}
            />
          )
        ))}
      <TermButton s={session} className={tab ?? undefined} />
      {session.live && <EndSessionButton sessionId={session.id} onEnded={onClose} className={tab ?? undefined} />}
      <button type="button" onClick={onClose} className={tab ?? "border border-code-dim px-2 text-xs uppercase hover:border-code"}>
        esc
      </button>
    </div>
  );

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

  // New messages scroll to the bottom if following; older ones loaded on top keep the view where it was.
  const newest = feed?.length ? `${feed.length}-${feed[feed.length - 1]?.at}` : "";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && keepFrom.current !== null) {
      el.scrollTop += el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
      return;
    }
    if (!following.current) return;
    bottom.current?.scrollIntoView({ block: "end" });
    setSeen(feed?.at(-1) ?? null);
  }, [newest]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (following.current) setSeen(feed?.at(-1) ?? null);
  };

  const jumpToBottom = () => {
    following.current = true;
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    setSeen(feed?.at(-1) ?? null);
  };

  // How many messages landed below the view since the user scrolled up. -1: some, count unknown
  // (the last one seen fell out of the loaded page).
  const unseen = (() => {
    if (!feed?.length || !seen) return 0;
    const last = feed.at(-1);
    if (last?.at === seen.at && last?.text === seen.text) return 0;
    for (let i = feed.length - 1; i >= 0; i--) {
      if (feed[i]?.at === seen.at && feed[i]?.text === seen.text) return feed.length - 1 - i;
    }
    return -1;
  })();

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
          if ((e.target as Element).closest("a, button, input, label, textarea, summary, details, [data-resize]")) return;
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
        <header className="@container border-b border-code-dim">
          {/* The buttons sit top right of the title, or get their own bar across the top
              when they'd squeeze the branch name. */}
          {stacked && <div className="border-b border-code-dim">{buttons}</div>}
          <div className="space-y-1 p-2">
            <div ref={titleRow} className="flex items-start gap-2">
              <div className="min-w-0 flex-1 truncate text-sm font-bold">
                <span ref={titleText}>
                  {session.project}
                  {session.branch && <span className="font-normal text-code-dim"> {session.branch}</span>}
                </span>
              </div>
              {!stacked && buttons}
            </div>
            <div className="min-w-0 text-xs">
              {sessionName(session) && <div className="truncate">{sessionName(session)}</div>}
              {session.topic && <div className="truncate text-code-dim">now: {session.topic}</div>}
              <div className="truncate text-code-dark" title="Session id: what sop and the transcript call it">
                {session.id.slice(0, 8)}
                {session.customTitle && session.title && session.customTitle !== session.title ? ` · started as "${session.title}"` : ""}
              </div>
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
                {session.paused && <span className="text-white">paused {untilLabel(session)} · </span>}
                {session.status === "closed" ? closedOutcome(session).text : session.statusDetail} · {session.cwd}
              </div>
            </div>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scroller} onScroll={onScroll} className="flex-1 space-y-2 overflow-y-auto p-2 text-sm">
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
            {feed && feedRows(feed).map((row, n) => {
              if (row.kind === "tools") return <ToolBlock key={`tools-${row.items[0]?.at}-${row.items[0]?.text}`} items={row.items} />;
              const { item, i } = row;
              const k = KIND_STYLE[item.kind];
              // Each of your messages starts a turn: a rule and room above it, so the chat
              // reads in chunks and your own words are the landmarks when scrolling back.
              const turn = item.kind === "user" && n > 0;
              return (
                  <div key={`${item.at}-${i}`} className={turn ? "!mt-6 border-t border-code-dark pt-4" : ""}>
                  <div className={`border-l-2 pl-2 ${k.cls}`}>
                    <div className={`text-[10px] uppercase tracking-widest ${k.labelCls}`}>
                      {k.label} {time(item.at)}
                    </div>
                    <div className="whitespace-pre-wrap break-words">
                      <Linkified text={item.text} session={session} />
                    </div>
                  </div>
                  </div>
              );
            })}
            <div ref={bottom} />
          </div>
          {unseen !== 0 && (
            <button
              type="button"
              onClick={jumpToBottom}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 border border-code bg-black px-3 py-0.5 text-xs font-bold uppercase hover:bg-code hover:text-black hover:[text-shadow:none]"
            >
              ↓ {unseen > 0 ? `${unseen} new` : "new messages"}
            </button>
          )}
        </div>

        <footer className="border-t border-code-dim p-2">
          {decisions.length > 0 ? (
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">{decisions}</div>
          ) : session.live ? (
            <ReplyBox sessionId={session.id} says={session.nextSays} autoFocus images={images} onSent={jumpToBottom} />
          ) : (
            <p className="text-xs text-code-dim">not running - can't reply from here</p>
          )}
        </footer>
      </aside>
    </div>
  );
}

// Exits Claude and closes its iTerm tab or tmux pane. Ending asks first what to clean up: servers it left running, its worktree and branch,
// its scratch folder. The server exits the session, then does only what's ticked.
function EndSessionButton({ sessionId, onEnded, className }: { sessionId: string; onEnded: () => void; className?: string }) {
  const [items, setItems] = useState<CleanupItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<CleanupResult[]>([]);

  const openChecklist = async () => {
    setOpen(true);
    setItems(null);
    setError(null);
    setFailed([]);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/cleanup`);
      const list = res.ok ? ((await res.json()) as CleanupItem[]) : [];
      setItems(list);
      setPicked(new Set(list.filter((i) => i.available && i.defaultOn).map((i) => i.id)));
    } catch {
      setItems([]);
    }
  };

  const end = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cleanup: [...picked] }),
      });
      const body = (await res.json()) as { error?: string; results?: CleanupResult[] };
      if (!res.ok) return setError(body.error ?? "Close failed");
      const bad = (body.results ?? []).filter((r) => !r.ok);
      // Ended, but some cleanup didn't happen: say what, and let them close the panel.
      if (bad.length > 0) return setFailed(bad);
      onEnded();
    } catch {
      setError("Server unreachable");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={() => (open ? setOpen(false) : void openChecklist())}
        title="Exit Claude, close its tab or pane, and clean up what it left"
        className={
          className
            ? `${className} ${open ? "bg-fail font-bold text-black [text-shadow:none]" : "text-fail"}`
            : `border px-2 text-xs uppercase ${open ? "border-fail bg-fail font-bold text-black [text-shadow:none]" : "border-code-dim text-fail hover:border-fail"}`
        }
      >
        end session
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[min(32rem,100cqw)] border border-fail bg-black p-2 text-left text-xs shadow-lg">
          {failed.length > 0 ? (
            <>
              <p className="font-bold uppercase text-fail">Ended, but some cleanup didn't happen</p>
              <ul className="mt-1 space-y-1">
                {failed.map((r) => (
                  <li key={r.id}>
                    <span className="text-white">{items?.find((i) => i.id === r.id)?.label ?? r.id}</span>
                    <span className="block text-fail">{r.error}</span>
                  </li>
                ))}
              </ul>
              <button type="button" onClick={onEnded} className="mt-2 border border-code-dim px-2 uppercase hover:border-code">
                ok
              </button>
            </>
          ) : (
            <>
              <p className="font-bold uppercase text-fail">End session and clean up</p>
              {items === null ? (
                <p className="cursor mt-1 text-code-dim">looking for leftovers</p>
              ) : items.length === 0 ? (
                <p className="mt-1 text-code-dim">nothing left behind to clean up</p>
              ) : (
                <ul className="mt-1 space-y-1.5">
                  {items.map((i) => (
                    <li key={i.id}>
                      <label className={`flex gap-2 ${i.available ? "cursor-pointer" : "opacity-50"}`}>
                        <input
                          type="checkbox"
                          disabled={!i.available}
                          checked={picked.has(i.id)}
                          onChange={() => toggle(i.id)}
                          className="mt-0.5 accent-[var(--color-code)]"
                        />
                        <span className="min-w-0">
                          <span className="block text-white">{i.label}</span>
                          <span className="block truncate text-code-dim" title={i.detail}>
                            {i.detail}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {error && <p className="mt-1 text-fail">{error}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy || items === null}
                  onClick={() => void end()}
                  className="border border-fail bg-fail px-3 font-bold uppercase text-black [text-shadow:none] hover:bg-black hover:text-fail disabled:opacity-40"
                >
                  {busy ? "ending..." : picked.size > 0 ? `end + clean ${picked.size}` : "end session"}
                </button>
                <button type="button" onClick={() => setOpen(false)} className="border border-code-dim px-2 uppercase hover:border-code">
                  cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
