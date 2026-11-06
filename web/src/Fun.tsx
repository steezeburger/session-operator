import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type OperatorState, type PointEvent, type Points, type Settings, type Theme } from "../../server/types.ts";
import { randomGlyph } from "./MatrixRain.tsx";

const ALL_CLEAR_AFTER_MS = 2000;
const BANNER_MS = 4000;
const DECODE_STEP_MS = 35;
const FLOATER_MS = 1600;
const DISSOLVE_MS = 900;
const DISSOLVE_GLYPH = 14;
const DISSOLVE_MAX = 260;
const TICK_UP_MS = 600;

const THEME_KEY = "deck-theme";
const THEME_ROWS: { key: Theme; label: string; detail: string }[] = [
  { key: "matrix", label: "Matrix", detail: "green rain" },
  { key: "hud", label: "Cyber HUD", detail: "a riveted 90s cockpit" },
];

const SETTING_ROWS: { key: Exclude<keyof Settings, "theme">; label: string; detail: string }[] = [
  { key: "rain", label: "Rain", detail: "the digital rain behind the deck" },
  { key: "allClear", label: "All clear", detail: "a banner when nothing needs you, and the rain slows" },
  { key: "shipped", label: "Shipped", detail: "a purple burst and a banner when something ships" },
  { key: "dissolve", label: "Dissolve", detail: "a row falls apart into glyphs when you answer it" },
  { key: "points", label: "Points", detail: "the score in the header, and +N as you earn it" },
];

/** The saved settings, from settings.json. The defaults until they've loaded. */
export function useSettings() {
  // The theme from last time, so a reload doesn't flash the other one while settings load.
  const [settings, setSettings] = useState<Settings>(() =>
    localStorage.getItem(THEME_KEY) === "hud" ? { ...DEFAULT_SETTINGS, theme: "hud" } : DEFAULT_SETTINGS,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/settings")
      .then((res) => res.json() as Promise<Settings>)
      .then(setSettings)
      .catch(() => {});
  }, []);

  const theme = settings.theme === "hud" ? "hud" : "matrix";
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const change = useCallback(async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    const before = settings[key];
    setSettings((cur) => ({ ...cur, [key]: value }));
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (Settings & { error?: string }) | null;
    if (res?.ok && body) {
      setSettings(body);
      setError(null);
    } else {
      setSettings((cur) => ({ ...cur, [key]: before }));
      setError(body?.error ?? "couldn't save that");
    }
  }, [settings]);

  return { settings, change, error };
}

// What the cockpit's settings window says about each setting, and its icon on a 16x16 grid.
const HUD_ABOUT: Record<string, { icon: string; what: string; on: string; off: string }> = {
  allClear: {
    icon: "M13 3h2v3h-1v1h-1v1h-1v1h-1v1h-1v1H9v1H8v1H6v-1H5v-1H4v-1H3V9H2V7h2v1h1v1h1v1h2V9h1V8h1V7h1V6h1V5h1V4h1z",
    what: "Tells you when you've cleared everything that was waiting on you.",
    on: "A banner when nothing needs you.",
    off: "The deck stays quiet.",
  },
  shipped: {
    icon: "M7 1h2v1h1v2h1v5h1v1h1v3h-1v-1h-1v1H9v2H7v-2H5v-1H4v1H3v-3h1V9h1V4h1V2h1zM7 5v2h2V5z",
    what: "Marks the moment a session's work lands.",
    on: "A banner, and the cockpit flashes purple.",
    off: "It just moves to Closed.",
  },
  dissolve: {
    icon: "M2 2h4v4H2zM8 2h3v3H8zM13 2h2v2h-2zM2 8h3v3H2zM7 7h2v2H7zM11 7h2v2h-2zM2 13h2v2H2zM6 12h2v2H6zM10 11h1v1h-1zM13 12h1v1h-1z",
    what: "What a row does as you answer it.",
    on: "It falls apart into glyphs.",
    off: "It just moves.",
  },
  points: {
    icon: "M7 1h2v4h5v2h-1v1h-1v1h-1v2h1v3h-2v-1H9v-1H7v1H6v1H4v-3h1V9H4V8H3V7H2V5h5z",
    what: "Answers pay more the bigger the ask, and shipping pays most.",
    on: "The score up top, and +N as you earn it.",
    off: "No score on the deck. It still adds up.",
  },
};

/** A thumbnail of a theme, drawn rather than captured so it never goes stale. */
function ThemePreview({ theme }: { theme: Theme }) {
  if (theme === "matrix") {
    return (
      <svg className="hs-preview" viewBox="0 0 80 50" shapeRendering="crispEdges" role="img" aria-label="Matrix theme preview">
        <rect width="80" height="50" fill="#000" />
        <path fill="#0a5a22" d="M4 0h1v22H4zM13 0h1v38H13zM66 0h1v14H66zM75 0h1v44H75z" />
        <rect x="8" y="4" width="64" height="4" fill="none" stroke="#00ff41" strokeWidth="0.5" />
        <path fill="#ffb000" d="M18 12h44v7H18z" />
        <path fill="#00ff41" d="M18 23h8v3h-8zM18 28h8v3h-8zM18 33h8v3h-8z" />
        <path fill="#00a82b" d="M28 23h34v3H28zM28 28h26v3H28zM28 33h30v3H28z" />
      </svg>
    );
  }
  return (
    <svg className="hs-preview" viewBox="0 0 80 50" shapeRendering="crispEdges" role="img" aria-label="Cyber HUD theme preview">
      <rect width="80" height="50" fill="#4a4a60" />
      <path fill="#050a07" d="M2 2h18v7H2zM22 2h32v7H22zM56 2h22v7H56zM8 11h70v26H8zM2 39h16v9H2zM20 39h38v9H20zM60 39h18v9H60z" />
      <path fill="#14141c" d="M2 11h5v4H2zM2 16h5v4H2zM2 21h5v4H2z" />
      <path fill="#ffc61a" d="M58 3h5v1h-5zM11 13h20v4H11z" />
      <path fill="#5cf05c" d="M58 6h12v1H58zM11 20h7v2h-7zM11 24h7v2h-7zM11 28h7v2h-7zM62 43h2v2h-2z" />
      <path fill="#3aa548" d="M20 20h40v2H20zM20 24h30v2H20zM20 28h36v2H20z" />
      <path fill="#f0702a" d="M24 4h20v2H24zM5 42h6v3H5z" />
      <path fill="#e04fd0" d="M5 6h1v2H5zM8 4h1v4H8zM11 5h1v3h-1z" />
    </svg>
  );
}

function HudSettings({
  settings,
  error,
  points,
  onChange,
  onClose,
}: {
  settings: Settings;
  error: string | null;
  points: Points | undefined;
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onClose: () => void;
}) {
  // The cockpit has no rain to turn off.
  const rows = SETTING_ROWS.filter((row) => row.key !== "rain");
  const [selected, setSelected] = useState(rows[0]!.key);
  const [previewing, setPreviewing] = useState<Theme | null>(null);
  const row = rows.find((r) => r.key === selected) ?? rows[0]!;
  const about = HUD_ABOUT[row.key];
  const box = useRef<HTMLDivElement>(null);

  const focusRow = useCallback((key: string) => {
    box.current?.querySelector<HTMLElement>(`[data-setting="${key}"]`)?.focus();
  }, []);
  // Starts on the table, so the arrows and enter work straight away.
  useEffect(() => focusRow(rows[0]!.key), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const step = e.key === "ArrowDown" || e.key === "j" ? 1 : e.key === "ArrowUp" || e.key === "k" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.key === selected);
    const next = rows[(at + step + rows.length) % rows.length]!.key;
    setSelected(next);
    focusRow(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div ref={box} className="hs-window" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h2 className="hs-title">Settings</h2>
        <div className="hs-side">
          <div className="hs-tab">Theme</div>
          <div role="radiogroup" aria-label="Theme" className="space-y-1">
            {THEME_ROWS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={settings.theme === t.key}
                className="hs-box"
                onClick={() => onChange("theme", t.key)}
                onPointerEnter={() => setPreviewing(t.key)}
                onPointerLeave={() => setPreviewing(null)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="hs-tab hs-preview-tab">Appearance</div>
          <ThemePreview theme={previewing ?? settings.theme} />
        </div>
        <div className="hs-main">
          <div className="hs-tab">Deck</div>
          <div className="hs-table">
            <div className="hs-head">
              <span>Setting</span>
              <span>State</span>
            </div>
            {rows.map((r) => (
              <button
                key={r.key}
                type="button"
                role="switch"
                aria-checked={settings[r.key]}
                data-setting={r.key}
                data-on={settings[r.key]}
                className={`hs-row ${r.key === row.key ? "selected" : ""}`}
                onClick={() => onChange(r.key, !settings[r.key])}
                onPointerEnter={() => setSelected(r.key)}
                onFocus={() => setSelected(r.key)}
              >
                <span>{r.label}</span>
                <span className="hs-state">{settings[r.key] ? "On" : "Off"}</span>
              </button>
            ))}
          </div>
          {about && (
            <div className="hs-about">
              <svg className="hs-icon" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
                <path d={about.icon} fill="currentColor" />
              </svg>
              <div>
                <h3>{row.label}</h3>
                <p>{about.what}</p>
                <p>ON: {about.on}</p>
                <p>OFF: {about.off}</p>
              </div>
            </div>
          )}
        </div>
        <div className="hs-actions">
          {points && (
            <span className="hs-readout" title={`${points.today.toLocaleString()} today`}>
              Score <b>{points.total.toLocaleString()}</b>
            </span>
          )}
          <button type="button" className="hs-box" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <p className="hs-note error">{error}</p>}
        <p className="hs-note">saved in ~/.config/session-operator</p>
      </div>
    </div>
  );
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
  onChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
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

  if (settings.theme === "hud") {
    return <HudSettings settings={settings} error={error} points={points} onChange={onChange} onClose={onClose} />;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="glow w-full max-w-md border border-code bg-black p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-xs font-bold uppercase tracking-widest">Settings</h2>
        <div className="mb-3 flex gap-2 text-sm" role="radiogroup" aria-label="Theme">
          {THEME_ROWS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={settings.theme === t.key}
              onClick={() => onChange("theme", t.key)}
              className={`flex-1 border px-2 py-1 text-left [text-shadow:none] ${settings.theme === t.key ? "border-code bg-code text-black" : "border-code-dim hover:border-code"}`}
            >
              <span className="font-bold">{t.label}</span>
              <span className="block text-xs">{t.detail}</span>
            </button>
          ))}
        </div>
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
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-code").trim() || "#00ff41";
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
