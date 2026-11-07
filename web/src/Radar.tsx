import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { Session, SessionStatus } from "../../server/types.ts";

// Staleness at a glance, in both themes. The theme decides where it sits and how its box looks;
// its styles are in index.css.

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
/** A ring tighter than this, in pixels, keeps its label to itself: it would sit on the blips. */
const RADAR_LABEL_MIN_PX = 20;
const DRAG_PX = 3;

const BLIP_COLOR: Record<SessionStatus, string> = {
  waiting: "var(--color-needs)",
  done: "var(--color-needs)",
  failing: "var(--color-fail)",
  blocked: "var(--color-blocked)",
  working: "var(--color-working)",
  idle: "var(--color-code-dim)",
  closed: "var(--color-code-dim)",
};

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
export function Radar({ sessions, now, onOpen, className }: { sessions: Session[]; now: number; onOpen: (id: string) => void; className: string }) {
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
    <div className={`radar ${className}`}>
      <div
        ref={field}
        className="radar-field"
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
          if (!(e.target as Element).closest(".radar-blip")) setView(RADAR_HOME);
        }}
      >
        <div className="radar-layer" aria-hidden="true" />
        {RADAR_RINGS.map(([mins, label]) => (
          <div key={label} className="radar-ring" style={{ "--r": radarReach(mins) } as CSSProperties} aria-hidden="true">
            {radarReach(mins) * view.z * px >= RADAR_LABEL_MIN_PX && <span>{label}</span>}
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
              className="radar-blip"
              title={`${name}${s.branch ? ` ${s.branch}` : ""}`}
              aria-label={`Open ${name}`}
              onClick={() => onOpen(s.id)}
              style={{ "--bx": Math.cos(a) * reach, "--by": Math.sin(a) * reach, color: BLIP_COLOR[s.status] } as CSSProperties}
            >
              {view.z >= RADAR_NAMES_AT && <span className="radar-blip-name">{name}</span>}
            </button>
          );
        })}
        <div className="radar-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
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
