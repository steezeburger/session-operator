import { useEffect, useRef, useState } from "react";
import type { Session } from "../../server/types.ts";

// What the server's parseUntil reads. "" is until you unpause.
const PRESETS: { label: string; until: string }[] = [
  { label: "1 hour", until: "1h" },
  { label: "tomorrow 9am", until: "tomorrow 9am" },
  { label: "next workday 9am", until: "workday 9am" },
  { label: "until I unpause", until: "" },
];

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function pauseSessions(ids: string[], until: string) {
  await Promise.all(ids.map((id) => post(`/api/sessions/${id}/pause`, { until })));
}

export async function unpauseSession(id: string) {
  await post(`/api/sessions/${id}/unpause`, {});
}

/** "until 6:30pm", "until tomorrow 9am", "until tue 9am", or "until you unpause". */
export function untilLabel(s: Session, now = Date.now()): string {
  if (!s.paused?.until) return "until you unpause";
  const at = new Date(s.paused.until);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(/\s/g, "").toLowerCase();
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `until ${time}`;
  if (days === 1) return `until tomorrow ${time}`;
  if (days < 7) return `until ${at.toLocaleDateString([], { weekday: "short" }).toLowerCase()} ${time}`;
  return `until ${at.toLocaleDateString([], { month: "short", day: "numeric" }).toLowerCase()} ${time}`;
}

/** A "pause" button with the presets under it. Pauses every id in `ids` on pick. */
export function PauseMenu({ ids, label = "pause", className = "" }: { ids: string[]; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  return (
    // Clicks stay here, so a card or row around it doesn't open too.
    <span ref={box} className={`relative flex ${className}`} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Put it off: no nudges or notifications, listed under Paused"
        className={`border px-2 text-xs uppercase ${open ? "border-code bg-code text-black [text-shadow:none]" : "border-code-dim text-code-dim hover:border-code hover:text-code"}`}
      >
        {label} ▾
      </button>
      {open && (
        <span className="absolute right-0 top-full z-30 mt-1 flex w-44 flex-col border border-code bg-black text-left text-xs shadow-lg">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => {
                setOpen(false);
                void pauseSessions(ids, p.until);
              }}
              className="px-2 py-1 text-left hover:bg-code hover:text-black hover:[text-shadow:none]"
            >
              {p.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
