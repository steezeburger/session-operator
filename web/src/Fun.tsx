import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type OperatorState, type PointEvent, type Points, type Settings } from "../../server/types.ts";
import { randomGlyph } from "./MatrixRain.tsx";

const ALL_CLEAR_AFTER_MS = 2000;
const BANNER_MS = 4000;
const DECODE_STEP_MS = 35;
const FLOATER_MS = 1600;
const DISSOLVE_MS = 900;
const DISSOLVE_GLYPH = 14;
const DISSOLVE_MAX = 260;
const TICK_UP_MS = 600;

const SETTING_ROWS: { key: keyof Settings; label: string; detail: string }[] = [
  { key: "rain", label: "Rain", detail: "the digital rain behind the deck" },
  { key: "allClear", label: "All clear", detail: "a banner when nothing needs you, and the rain slows" },
  { key: "shipped", label: "Shipped", detail: "a purple burst and a banner when something ships" },
  { key: "dissolve", label: "Dissolve", detail: "a row falls apart into glyphs when you answer it" },
  { key: "points", label: "Points", detail: "the score in the header, and +N as you earn it" },
];

/** The saved settings, from settings.json. The defaults until they've loaded. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/settings")
      .then((res) => res.json() as Promise<Settings>)
      .then(setSettings)
      .catch(() => {});
  }, []);

  const change = useCallback(async (key: keyof Settings, on: boolean) => {
    setSettings((cur) => ({ ...cur, [key]: on }));
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: on }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (Settings & { error?: string }) | null;
    if (res?.ok && body) {
      setSettings(body);
      setError(null);
    } else {
      setSettings((cur) => ({ ...cur, [key]: !on }));
      setError(body?.error ?? "couldn't save that");
    }
  }, []);

  return { settings, change, error };
}

export function SettingsPanel({
  settings,
  error,
  points,
  onChange,
  onClose,
}: {
  settings: Settings;
  error: string | null;
  points: Points | undefined;
  onChange: (key: keyof Settings, on: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    // Capture, so Escape closes this and not the session panel behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== ",") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="glow w-full max-w-md border border-code bg-black p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-widest">Settings</h2>
        <ul className="space-y-2 text-sm">
          {SETTING_ROWS.map((row) => (
            <li key={row.key}>
              <label className="flex cursor-pointer items-baseline gap-2">
                <input
                  type="checkbox"
                  checked={settings[row.key]}
                  onChange={(e) => onChange(row.key, e.target.checked)}
                  className="accent-code"
                />
                <span className="font-bold text-white">{row.label}</span>
                <span className="text-xs text-code-dim">{row.detail}</span>
              </label>
            </li>
          ))}
        </ul>
        {error && <p className="mt-3 text-xs text-fail">{error}</p>}
        {points && (
          <p className="mt-3 text-xs text-code-dim">
            {points.total.toLocaleString()} points, {points.today.toLocaleString()} today
          </p>
        )}
        <p className="mt-3 text-xs text-code-dim">saved in ~/.config/session-operator</p>
      </div>
    </div>
  );
}

/** Text that scrambles into place, left to right. */
function Decoded({ text }: { text: string }) {
  const [shown, setShown] = useState("");
  useEffect(() => {
    let at = 0;
    const tick = setInterval(() => {
      at += 1;
      const rest = Array.from({ length: Math.max(0, text.length - at) }, randomGlyph).join("");
      setShown(text.slice(0, at) + rest);
      if (at >= text.length) clearInterval(tick);
    }, DECODE_STEP_MS);
    return () => clearInterval(tick);
  }, [text]);
  return <>{shown}</>;
}

interface Banner {
  id: string;
  text: string;
  sub: string;
  shipped: boolean;
}

function BannerView({ banner }: { banner: Banner }) {
  const color = banner.shipped ? "border-[#b48cff] text-[#b48cff]" : "border-code text-code";
  return (
    <div
      style={{ viewTransitionName: "deck-banner" }}
      className="banner pointer-events-none fixed inset-x-4 top-1/3 z-40 flex justify-center"
      role="status"
    >
      <div className={`border-2 ${color} bg-black/90 px-8 py-4 text-center`}>
        <div className="text-2xl font-bold uppercase tracking-[0.3em]">
          <Decoded text={banner.text} />
        </div>
        {banner.sub && <div className="mt-1 text-xs">{banner.sub}</div>}
      </div>
    </div>
  );
}

/** What the deck plays as things happen: banners, the rain's mood, and +N on the score. */
export function useFun(state: OperatorState | null, settings: Settings, needsCount: number, pausedCount: number) {
  const [banners, setBanners] = useState<Banner[]>([]);
  const [burst, setBurst] = useState(0);
  const [floaters, setFloaters] = useState<PointEvent[]>([]);
  const show = useCallback((b: Banner) => setBanners((cur) => [...cur, b]), []);

  // One banner at a time, in order.
  const current = banners[0];
  useEffect(() => {
    if (!current) return;
    const done = setTimeout(() => setBanners((cur) => cur.slice(1)), BANNER_MS);
    return () => clearTimeout(done);
  }, [current]);

  // The events already on the first state are old news, so a reload plays nothing.
  const played = useRef<Set<string> | null>(null);
  const recent = state?.points.recent;
  useEffect(() => {
    if (!recent) return;
    if (!played.current) {
      played.current = new Set(recent.map((e) => e.id));
      return;
    }
    for (const e of recent) {
      if (played.current.has(e.id)) continue;
      played.current.add(e.id);
      if (settings.points) {
        setFloaters((cur) => [...cur, e]);
        setTimeout(() => setFloaters((cur) => cur.filter((f) => f.id !== e.id)), FLOATER_MS);
      }
      if (e.kind === "shipped" && settings.shipped) {
        setBurst((n) => n + 1);
        show({ id: e.id, text: "Shipped", sub: e.label, shipped: true });
      }
    }
  }, [recent, settings.points, settings.shipped, show]);

  // Waits a moment, because a row can leave Needs you for a beat and come back. Pausing
  // everything isn't clearing it, so that stays quiet.
  const before = useRef<{ needs: number; paused: number } | null>(null);
  const ready = state !== null;
  useEffect(() => {
    if (!ready) return;
    const was = before.current;
    before.current = { needs: needsCount, paused: pausedCount };
    if (!was || was.needs === 0 || needsCount > 0 || pausedCount > was.paused || !settings.allClear) return;
    const go = setTimeout(() => show({ id: `clear-${Date.now()}`, text: "All clear", sub: "nothing needs you", shipped: false }), ALL_CLEAR_AFTER_MS);
    return () => clearTimeout(go);
    // Only a change in the count starts or cancels the wait.
  }, [ready, needsCount]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    burst,
    calm: ready && needsCount === 0 && settings.allClear,
    banner: current ? <BannerView key={current.id} banner={current} /> : null,
    floaters,
  };
}

/** The score in the header. Counts up to a new total, with each +N floating off it. */
export function Score({ points, floaters }: { points: Points; floaters: PointEvent[] }) {
  const [shown, setShown] = useState(points.total);
  const from = useRef(points.total);
  useEffect(() => {
    const start = from.current;
    if (start === points.total) return;
    const began = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / TICK_UP_MS);
      const value = Math.round(start + (points.total - start) * t);
      setShown(value);
      from.current = value;
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [points.total]);

  return (
    <span className="relative mr-3" title={`${points.today.toLocaleString()} today. Answers pay more the bigger the ask, shipping pays most.`}>
      <span className="font-bold text-white">{shown.toLocaleString()}</span> pts
      {floaters.map((f) => (
        <span key={f.id} className="floater absolute right-0 top-4 whitespace-nowrap font-bold text-white">
          +{f.points}
        </span>
      ))}
    </span>
  );
}

/** Drops a row's area as falling glyphs. Drawn on top, so the row itself moves as usual. */
export function dissolve(rowId: string) {
  const r = document.querySelector(`[data-row="${CSS.escape(rowId)}"]`)?.getBoundingClientRect();
  if (!r || r.width === 0) return;
  const canvas = document.createElement("canvas");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;z-index:30;pointer-events:none;view-transition-name:deck-dissolve";
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas.remove();

  const top = Math.max(r.top, 0);
  const bottom = Math.min(r.bottom, window.innerHeight);
  const count = Math.min(DISSOLVE_MAX, Math.ceil((r.width * (bottom - top)) / (DISSOLVE_GLYPH * DISSOLVE_GLYPH)));
  const glyphs = Array.from({ length: count }, () => ({
    x: r.left + Math.random() * r.width,
    y: top + Math.random() * (bottom - top),
    speed: 120 + Math.random() * 420,
    ch: randomGlyph(),
  }));
  const began = performance.now();
  ctx.font = `${DISSOLVE_GLYPH}px ui-monospace, monospace`;
  ctx.fillStyle = "#00ff41";
  const frame = (now: number) => {
    const t = (now - began) / DISSOLVE_MS;
    if (t >= 1) return canvas.remove();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1 - t;
    for (const g of glyphs) ctx.fillText(g.ch, g.x, g.y + g.speed * t * t);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
