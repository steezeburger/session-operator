import { useState } from "react";

export async function postReply(sessionId: string, text: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (res.ok) return null;
    return ((await res.json()) as { error?: string }).error ?? "Reply failed";
  } catch {
    return "Server unreachable";
  }
}

// Types the reply into the session's iTerm tab and presses Enter.
export function ReplyBox({ sessionId, say, autoFocus }: { sessionId: string; say?: string | null; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [sending, setSending] = useState(false);

  const send = async (value: string) => {
    if (!value.trim() || sending) return;
    setSending(true);
    const error = await postReply(sessionId, value);
    setSending(false);
    if (error) return setStatus({ ok: false, msg: error });
    setText("");
    setStatus({ ok: true, msg: "sent" });
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    // Clicks in here shouldn't open the session panel.
    <div className="mt-1.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <form
        className="flex flex-wrap items-stretch gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        {say && (
          <button
            type="button"
            onClick={() => void send(say)}
            disabled={sending}
            title={say}
            className="max-w-full basis-full truncate border border-needs px-2 text-left text-sm font-bold text-needs hover:bg-needs hover:text-black hover:[text-shadow:none]"
          >
            say "{say}"
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-start border border-code-dim bg-black focus-within:border-code">
          <span className="py-1 pl-2 text-sm text-code-dim">{">"}</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            rows={Math.min(8, text.split("\n").length)}
            placeholder="reply to claude (shift+enter for a new line)"
            autoFocus={autoFocus}
            className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-white caret-code outline-none placeholder:text-code-dark"
          />
        </div>
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="shrink-0 border border-code px-3 text-sm font-bold uppercase hover:bg-code hover:text-black hover:[text-shadow:none] disabled:opacity-40"
        >
          {sending ? "..." : "send"}
        </button>
      </form>
      {status && <p className={`mt-1 text-xs ${status.ok ? "text-code" : "text-fail"}`}>{status.msg}</p>}
    </div>
  );
}
