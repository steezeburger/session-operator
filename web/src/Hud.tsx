import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CleanupItem, CleanupResult, PointEvent, Points, Session } from "../../server/types.ts";
import { Score } from "./Fun.tsx";
import { Radar } from "./Radar.tsx";
import { ago } from "./Sort.tsx";

// The cockpit theme's own instruments. Each one says something the others don't: counts live only
// in the top meters, staleness only on the radar. The panel art itself is in index.css.

const METER_CHEVRONS = 20;

const METERS: { key: string; label: string; color: string }[] = [
  { key: "needs", label: "Need", color: "var(--color-needs)" },
  { key: "failing", label: "Fail", color: "var(--color-fail)" },
  { key: "blocked", label: "Wait", color: "var(--color-blocked)" },
  { key: "working", label: "Work", color: "var(--color-working)" },
];

/** The score, over a bar for each recent payout. */
export function HudScore({ points, floaters }: { points: Points; floaters: PointEvent[] }) {
  const top = Math.max(1, ...points.recent.map((e) => e.points));
  return (
    <div className="hud-score hud-screen">
      <span className="hud-tag">Score</span>
      <div className="hud-score-total">
        <Score points={points} floaters={floaters} />
      </div>
      <div className="hud-score-bars" aria-hidden="true">
        {points.recent.map((e) => (
          <i key={e.id} title={`+${e.points} ${e.label}`} className={e.kind === "shipped" ? "shipped" : undefined} style={{ height: `${(e.points / top) * 100}%` }} />
        ))}
      </div>
    </div>
  );
}

/** One chevron per session in each state, the way the top bars count. */
export function HudMeters({ groups }: { groups: { key: string; rows: unknown[] }[] }) {
  return (
    <div className="hud-meters hud-screen">
      {METERS.map((m) => {
        const count = groups.find((g) => g.key === m.key)?.rows.length ?? 0;
        return (
          <div key={m.key} className="hud-meter" style={{ color: m.color }} title={`${count} ${m.label.toLowerCase()}`}>
            <span className="hud-meter-label">{m.label}</span>
            <span className="hud-chevrons">
              {Array.from({ length: METER_CHEVRONS }, (_, i) => (
                <i key={i} className={i < count ? "on" : undefined} />
              ))}
            </span>
            <span className="hud-meter-count">{count}</span>
          </div>
        );
      })}
    </div>
  );
}

// 16x16 pixel icons, drawn as runs of squares.
const ICONS: Record<string, string> = {
  filter: "M1 2h14v2h-1v1h-1v1h-1v1h-1v1H9v6H7V8H6V7H5V6H4V5H3V4H2V3H1z",
  settings: "M7 1h2v2h2V2h2v2h-1v2h2v2h-2v2h1v2h-2v-1H9v2H7v-2H5v1H3v-2h1V8H2V6h2V4H3V2h2v1h2zM7 6v3h2V6z",
  keys: "M1 2h14v12H1zM3 4v8h10V4zM7 10h2v1H7zM6 5h4v1h1v2h-1v1H8V8h1V7h1V6H6v1H5V6h1z",
  matrix: "M2 1h2v3H2zM2 6h2v3H2zM7 3h2v3H7zM7 8h2v3H7zM7 13h2v2H7zM12 1h2v2h-2zM12 5h2v3h-2zM12 10h2v3h-2zM2 11h2v3H2z",
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 16 16" width="24" height="24" shapeRendering="crispEdges" aria-hidden="true">
      <path d={ICONS[name]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

function RailButton({ icon, label, title, onClick }: { icon: string; label: string; title: string; onClick: () => void }) {
  return (
    <button type="button" className="hud-socket" title={title} onClick={onClick}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
}

export function HudLeftRail({
  onFilter,
  onSettings,
  onKeys,
  onMatrix,
}: {
  onFilter: () => void;
  onSettings: () => void;
  onKeys: () => void;
  onMatrix: () => void;
}) {
  return (
    <nav className="hud-rail hud-rail-left" aria-label="Deck controls">
      <RailButton icon="filter" label="Find" title="Filter sessions ( / )" onClick={onFilter} />
      <RailButton icon="settings" label="Set" title="Settings ( , )" onClick={onSettings} />
      <RailButton icon="keys" label="Keys" title="Keyboard shortcuts ( ? )" onClick={onKeys} />
      <RailButton icon="matrix" label="Mtrx" title="Back to the Matrix theme" onClick={onMatrix} />
    </nav>
  );
}

/** The bottom panels: who has waited longest on you, the operator, and the radar. */
export function HudBottom({
  sessions,
  now,
  onOpen,
  children,
}: {
  sessions: Session[];
  now: number;
  onOpen: (id: string) => void;
  children: ReactNode;
}) {
  const waiting = sessions.filter((s) => !s.paused && (s.status === "waiting" || s.status === "done"));
  const longest = waiting.reduce<Session | null>((a, s) => (!a || s.lastActivity < a.lastActivity ? s : a), null);
  return (
    <section className="hud-bottom">
      <button
        type="button"
        className="hud-readout hud-screen"
        disabled={!longest}
        title={longest ? `Open ${longest.repo ?? longest.project}` : "Nothing is waiting on you"}
        onClick={() => longest && onOpen(longest.id)}
      >
        <span className="hud-readout-title">Longest wait</span>
        <span className="hud-readout-body">
          <svg viewBox="0 0 16 16" width="48" height="48" shapeRendering="crispEdges" aria-hidden="true">
            <path d="M1 2h14v10H9v1h2v1H5v-1h2v-1H1zM3 4v6h10V4zM4 5h1v1h1v1H5v1H4V7h1V6H4zM7 7h3v1H7z" fill="currentColor" fillRule="evenodd" />
          </svg>
          <span className={`hud-digits ${longest ? "lit" : ""}`}>{longest ? ago(longest.lastActivity, now) : "--"}</span>
        </span>
        <span className="hud-readout-foot">{longest ? (longest.repo ?? longest.project) : "All clear"}</span>
      </button>
      <div className="hud-console hud-screen">{children}</div>
      <Radar className="hud-screen" sessions={sessions} now={now} onOpen={onOpen} />
    </section>
  );
}

const TRASH_ICON = "M6 1h4v2h4v2H2V3h4zM3 6h10v9H3zM5 8v5h2V8zM9 8v5h2V8z";

/** Ending a session, in the settings window's style: pick what to clean up, then end it. */
export function HudEndWindow({
  items,
  picked,
  busy,
  error,
  failed,
  onToggle,
  onEnd,
  onCancel,
  onEnded,
}: {
  items: CleanupItem[] | null;
  picked: Set<string>;
  busy: boolean;
  error: string | null;
  failed: CleanupResult[];
  onToggle: (id: string) => void;
  onEnd: () => void;
  onCancel: () => void;
  onEnded: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items?.find((i) => i.id === selectedId) ?? items?.[0];
  const box = useRef<HTMLDivElement>(null);
  const hasItems = (items?.length ?? 0) > 0;

  // Starts on the table, never on the End button, so a stray enter can't end the session.
  useEffect(() => {
    if (hasItems) box.current?.querySelector<HTMLElement>("[data-cleanup]")?.focus();
  }, [hasItems]);

  // Capture, so Escape closes this and not the session panel behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (failed.length > 0) onEnded();
      else if (!busy) onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, failed.length, onCancel, onEnded]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!step || !items || !selected) return;
    e.preventDefault();
    const next = items[(items.indexOf(selected) + step + items.length) % items.length]!;
    box.current?.querySelector<HTMLElement>(`[data-cleanup="${CSS.escape(next.id)}"]`)?.focus();
  };

  return createPortal(
    <div
      data-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={(e) => {
        e.stopPropagation();
        if (failed.length === 0 && !busy) onCancel();
      }}
    >
      <div ref={box} className="hs-window hs-end" role="dialog" aria-label="End session" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 className="hs-title">{failed.length > 0 ? "Session ended" : "End session"}</h2>
        {failed.length > 0 ? (
          <div className="hs-main">
            <div className="hs-tab">Cleanup that didn't happen</div>
            <div className="hs-table">
              {failed.map((r) => (
                <div key={r.id} className="hs-row hs-failed">
                  <span>{items?.find((i) => i.id === r.id)?.label ?? r.id}</span>
                  <span className="hs-does">{r.error}</span>
                </div>
              ))}
            </div>
          </div>
        ) : items === null ? (
          <p className="hs-note cursor">looking for leftovers</p>
        ) : !selected ? (
          <p className="hs-note">nothing left behind to clean up</p>
        ) : (
          <div className="hs-main">
            <div className="hs-tab">Leftovers</div>
            <div className="hs-table">
              <div className="hs-head">
                <span>Item</span>
                <span>On end</span>
              </div>
              {items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  role="switch"
                  aria-checked={picked.has(i.id)}
                  aria-disabled={!i.available}
                  data-cleanup={i.id}
                  data-on={picked.has(i.id)}
                  className={`hs-row ${i.id === selected.id ? "selected" : ""}`}
                  onClick={() => i.available && onToggle(i.id)}
                  onPointerEnter={() => setSelectedId(i.id)}
                  onFocus={() => setSelectedId(i.id)}
                >
                  <span className="truncate">{i.label}</span>
                  <span className="hs-state">{!i.available ? "Not offered" : picked.has(i.id) ? "Clean up" : "Keep"}</span>
                </button>
              ))}
            </div>
            <div className="hs-about">
              <svg className="hs-icon" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
                <path d={TRASH_ICON} fill="currentColor" fillRule="evenodd" />
              </svg>
              <div className="min-w-0">
                <h3>{selected.label}</h3>
                <p className="break-words">{selected.detail}</p>
              </div>
            </div>
          </div>
        )}
        {error && <p className="hs-note error">{error}</p>}
        <div className="hs-actions">
          {failed.length > 0 ? (
            <button type="button" className="hs-box ml-auto" onClick={onEnded}>
              OK
            </button>
          ) : (
            <>
              <p className="hs-note">exits Claude and closes its tab or pane</p>
              <button type="button" className="hs-box hs-danger ml-auto" disabled={busy || items === null} onClick={onEnd}>
                {busy ? "Ending..." : picked.size > 0 ? `End + clean ${picked.size}` : "End session"}
              </button>
              <button type="button" className="hs-box" disabled={busy} onClick={onCancel}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
