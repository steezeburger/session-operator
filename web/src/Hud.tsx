import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { PointEvent, Points, Session, SessionStatus } from "../../server/types.ts";
import { Score } from "./Fun.tsx";
import { ago } from "./Sort.tsx";

// The cockpit theme's own instruments. Each one says something the others don't: counts live only
// in the top meters, staleness only on the radar. The panel art itself is in index.css.

const METER_CHEVRONS = 20;
const RADAR_REACH_MIN = 24 * 60;
const RADAR_RINGS: [number, string][] = [
  [1, "1m"],
  [10, "10m"],
  [60, "1h"],
  [RADAR_REACH_MIN, "1d"],
];
const RADAR_MAX_ZOOM = 12;
const RADAR_BUTTON_ZOOM = 1.5;
const RADAR_NAMES_AT = 4;
const DRAG_PX = 3;

const METERS: { key: string; label: string; color: string }[] = [
  { key: "needs", label: "Need", color: "var(--color-needs)" },
  { key: "failing", label: "Fail", color: "var(--color-fail)" },
  { key: "blocked", label: "Wait", color: "var(--color-blocked)" },
  { key: "working", label: "Work", color: "var(--color-code)" },
];

const BLIP_COLOR: Record<SessionStatus, string> = {
  waiting: "var(--color-needs)",
  done: "var(--color-needs)",
  failing: "var(--color-fail)",
  blocked: "var(--color-blocked)",
  working: "var(--color-code)",
  idle: "var(--color-code-dim)",
  closed: "var(--color-code-dim)",
};

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

/** The same spot every time for one session, from its id. */
function bearing(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 360) * Math.PI) / 180;
}

/** How far out a session sits, in hundredths of the short side at no zoom: the longer since it did anything, the further. */
function radarReach(mins: number) {
  return 4 + (Math.log1p(Math.min(mins, RADAR_REACH_MIN)) / Math.log1p(RADAR_REACH_MIN)) * 40;
}

interface RadarView {
  z: number;
  x: number;
  y: number;
}
const RADAR_HOME: RadarView = { z: 1, x: 0, y: 0 };

/** Keeps the rings somewhere you can get back from. */
function panned(v: RadarView): RadarView {
  const most = 50 * v.z;
  return { z: v.z, x: Math.max(-most, Math.min(most, v.x)), y: Math.max(-most, Math.min(most, v.y)) };
}

/** Zoomed by `factor`, holding the point at (cx, cy) still. */
function zoomed(v: RadarView, factor: number, cx = 0, cy = 0): RadarView {
  const z = Math.max(1, Math.min(RADAR_MAX_ZOOM, v.z * factor));
  const k = z / v.z;
  return panned({ z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
}

/**
 * Every session that isn't closed, one blip each, placed by how long since it did anything.
 * Scroll to zoom, drag to move, and names show up once zoomed in.
 */
function Radar({ sessions, now, onOpen }: { sessions: Session[]; now: number; onOpen: (id: string) => void }) {
  const blips = sessions.filter((s) => s.status !== "closed");
  const [view, setView] = useState(RADAR_HOME);
  const field = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; from: RadarView; moved: boolean } | null>(null);
  // A drag that ends on a blip mustn't open it.
  const justDragged = useRef(false);

  // Pixels per unit, the unit the view is kept in: a hundredth of the short side. Folded away
  // behind a chat it measures nothing, so it keeps the last real size.
  const [px, setPx] = useState(1);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const measure = () => {
      const side = Math.min(el.clientWidth, el.clientHeight);
      if (side > 0) setPx(side / 100);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, []);

  // Not React's onWheel: that one is passive, and this mustn't scroll anything else.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const u = 100 / Math.max(1, Math.min(r.width, r.height));
      const cx = (e.clientX - r.left - r.width / 2) * u;
      const cy = (e.clientY - r.top - r.height / 2) * u;
      setView((v) => zoomed(v, Math.exp(-e.deltaY * 0.002), cx, cy));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    justDragged.current = false;
    if (e.button === 0) drag.current = { px: e.clientX, py: e.clientY, from: view, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setView(panned({ z: d.from.z, x: d.from.x + dx / px, y: d.from.y + dy / px }));
  };
  const onPointerEnd = () => {
    justDragged.current = drag.current?.moved ?? false;
    drag.current = null;
  };

  return (
    <div className="hud-radar hud-screen">
      <div
        ref={field}
        className="hud-radar-field"
        style={{ "--z": view.z, "--x": view.x, "--y": view.y, "--u": `${px}px` } as CSSProperties}
        title="Scroll to zoom, drag to move, double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={(e) => {
          if (!justDragged.current) return;
          justDragged.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
        onDoubleClick={(e) => {
          if (!(e.target as Element).closest(".hud-blip")) setView(RADAR_HOME);
        }}
      >
        <div className="hud-radar-layer" aria-hidden="true" />
        {RADAR_RINGS.map(([mins, label]) => (
          <div key={label} className="hud-ring" style={{ "--r": radarReach(mins) } as CSSProperties} aria-hidden="true">
            <span>{label}</span>
          </div>
        ))}
        {blips.map((s) => {
          const reach = radarReach(Math.max(0, (now - new Date(s.lastActivity).getTime()) / 60_000));
          const a = bearing(s.id);
          const name = s.repo ?? s.project;
          return (
            <button
              key={s.id}
              type="button"
              className="hud-blip"
              title={`${name}${s.branch ? ` ${s.branch}` : ""}`}
              aria-label={`Open ${name}`}
              onClick={() => onOpen(s.id)}
              style={{ "--bx": Math.cos(a) * reach, "--by": Math.sin(a) * reach, color: BLIP_COLOR[s.status] } as CSSProperties}
            >
              {view.z >= RADAR_NAMES_AT && <span className="hud-blip-name">{name}</span>}
            </button>
          );
        })}
        <div className="hud-radar-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" title="Zoom in" onClick={() => setView((v) => zoomed(v, RADAR_BUTTON_ZOOM))}>
            +
          </button>
          <button type="button" title="Zoom out" onClick={() => setView((v) => zoomed(v, 1 / RADAR_BUTTON_ZOOM))}>
            -
          </button>
          <button type="button" title="Reset the view" onClick={() => setView(RADAR_HOME)}>
            {view.z.toFixed(1)}x
          </button>
        </div>
      </div>
    </div>
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
      <Radar sessions={sessions} now={now} onOpen={onOpen} />
    </section>
  );
}
