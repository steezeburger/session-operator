import { useState } from "react";
import type { Session } from "../../server/types.ts";
import { WithMentions } from "./Refs.tsx";

// File paths inside Claude's text: absolute ones under the usual roots, ~/..., and relative
// ones with a folder and an extension (web/src/App.tsx:42). A trailing :line is kept on the
// label and dropped when opening. The lookbehind keeps it from starting mid-URL or mid-word.
const PATH_RE =
  /((?<![\w.:/~-])(?:~\/|\/(?:Users|private|var|tmp|Volumes|opt|Applications|Library)\/|(?:\.\.?\/)?[\w.-]+\/)[^\s"'`<>()[\]]*[^\s"'`<>()[\].,;:!?])/g;

// Relative matches need a "." somewhere after the last slash, or "and/or" would link.
function isPath(part: string) {
  if (part.startsWith("/") || part.startsWith("~/")) return true;
  return /\/[^/]*\.\w+(:\d+){0,2}$/.test(part);
}

export function WithPaths({ text, s }: { text: string; s: Pick<Session, "refs" | "refLinks" | "cwd"> }) {
  return (
    <>
      {text.split(PATH_RE).map((part, i) =>
        i % 2 === 1 && isPath(part) ? <FilePath key={i} path={part} cwd={s.cwd} /> : <WithMentions key={i} text={part} s={s} />,
      )}
    </>
  );
}

function FilePath({ path, cwd }: { path: string; cwd: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const res = await fetch("/api/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.replace(/(:\d+){1,2}$/, ""), cwd }),
    }).catch(() => null);
    setError(res?.ok ? null : ((await res?.json().catch(() => null))?.error ?? "couldn't open it"));
  };
  return (
    <a
      href="#"
      onClick={(e) => void open(e)}
      title={error ?? "open locally"}
      className={`underline decoration-dotted underline-offset-4 ${error ? "decoration-fail line-through" : "decoration-code-dim hover:decoration-code"}`}
    >
      {path}
    </a>
  );
}
