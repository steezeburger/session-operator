import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

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

export function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
}

async function uploadImage(file: File): Promise<string> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const res = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: file.type, data }),
  });
  const body = (await res.json()) as { path?: string; error?: string };
  if (!body.path) throw new Error(body.error ?? "Upload failed");
  return body.path;
}

function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="relative h-14 w-14 shrink-0 border border-code-dim">
      {url && <img src={url} alt={file.name} className="h-full w-full object-cover" />}
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="absolute -right-1.5 -top-1.5 h-4 w-4 border border-code-dim bg-black text-[10px] leading-none hover:border-fail hover:text-fail"
      >
        x
      </button>
    </div>
  );
}

type Images = [File[], Dispatch<SetStateAction<File[]>>];

// Types the reply into the session's iTerm tab and presses Enter. Images (dropped, pasted,
// or handed in by the parent panel) go first as file paths, which Claude Code attaches.
export function ReplyBox({
  sessionId,
  say,
  autoFocus,
  images: lifted,
  placeholder = "reply to claude (shift+enter for a new line, drop or paste images)",
}: {
  sessionId: string;
  placeholder?: string;
  say?: string | null;
  autoFocus?: boolean;
  images?: Images;
}) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [sending, setSending] = useState(false);
  const own = useState<File[]>([]);
  const [images, setImages] = lifted ?? own;
  const addImages = (files: File[]) => files.length > 0 && setImages((prev) => [...prev, ...files]);

  const send = async (value: string) => {
    if ((!value.trim() && images.length === 0) || sending) return;
    setSending(true);
    let paths: string[];
    try {
      paths = await Promise.all(images.map(uploadImage));
    } catch (e) {
      setSending(false);
      return setStatus({ ok: false, msg: (e as Error).message });
    }
    const error = await postReply(sessionId, [...paths, value.trim()].filter(Boolean).join(" "));
    setSending(false);
    if (error) return setStatus({ ok: false, msg: error });
    setText("");
    setImages([]);
    setStatus({ ok: true, msg: "sent" });
    setTimeout(() => setStatus(null), 2000);
  };

  return (
    // Clicks in here shouldn't open the session panel.
    <div
      className="mt-1.5"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      // Inside the session panel, the panel takes drops; inline boxes take their own.
      onDragOver={lifted ? undefined : (e) => e.preventDefault()}
      onDrop={
        lifted
          ? undefined
          : (e) => {
              e.preventDefault();
              e.stopPropagation();
              addImages(imageFiles(e.dataTransfer.files));
            }
      }
    >
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((f, i) => (
            <Thumb key={`${f.name}-${f.lastModified}-${i}`} file={f} onRemove={() => setImages((prev) => prev.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
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
            onPaste={(e) => {
              const files = imageFiles(e.clipboardData.files);
              if (files.length === 0) return;
              e.preventDefault();
              addImages(files);
            }}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(text);
              }
            }}
            rows={Math.min(8, text.split("\n").length)}
            placeholder={placeholder}
            autoFocus={autoFocus}
            className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-white caret-code outline-none placeholder:text-code-dark"
          />
        </div>
        <button
          type="submit"
          disabled={sending || (!text.trim() && images.length === 0)}
          className="shrink-0 border border-code px-3 text-sm font-bold uppercase hover:bg-code hover:text-black hover:[text-shadow:none] disabled:opacity-40"
        >
          {sending ? "..." : "send"}
        </button>
      </form>
      {status && <p className={`mt-1 text-xs ${status.ok ? "text-code" : "text-fail"}`}>{status.msg}</p>}
    </div>
  );
}
