import { useState } from "react";
import type { Session } from "../../server/types.ts";

// Brings the session's iTerm tab or tmux pane to the front. Only for a live session with a
// terminal; a failure turns it red for a moment with the reason in its tooltip. `className`
// replaces the bordered look, for a tab bar.
export function TermButton({ s, className }: { s: Session; className?: string }) {
  const [error, setError] = useState<string | null>(null);
  if (!s.live || !s.terminal) return null;

  const focus = async () => {
    setError(null);
    const res = await fetch(`/api/sessions/${s.id}/focus`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
    if (res?.ok) return;
    const body = (await res?.json().catch(() => null)) as { error?: string } | null;
    setError(body?.error ?? "Server unreachable");
    setTimeout(() => setError(null), 4000);
  };

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void focus();
      }}
      onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}
      title={error ?? `Bring its ${s.terminal === "tmux" ? "tmux pane" : "iTerm tab"} to the front`}
      className={
        className
          ? `${className} ${error ? "text-fail" : ""}`
          : `border px-1.5 text-xs uppercase leading-tight ${error ? "border-fail text-fail" : "border-code-dim hover:border-code"}`
      }
    >
      term
    </button>
  );
}
