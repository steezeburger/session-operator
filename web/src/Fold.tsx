import { useState } from "react";

// Which list sections are folded, kept across reloads. Paused, idle and closed start folded.
const FOLD_KEY = "operator.folds";
const FOLDED_AT_FIRST = new Set(["paused", "idle", "closed"]);

export function useFolds() {
  const [folds, setFolds] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const isOpen = (key: string) => !(folds[key] ?? FOLDED_AT_FIRST.has(key));
  const toggle = (key: string) => {
    const next = { ...folds, [key]: isOpen(key) };
    setFolds(next);
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(next));
    } catch {}
  };
  return { isOpen, toggle };
}

/**
 * What a section's title line spreads onto itself to fold the section: a click, plus what the
 * keys need to find it (keys.tsx). The section it heads carries `data-section`.
 */
export function foldProps(key: string, open: boolean, toggle: (key: string) => void) {
  return {
    role: "button",
    "data-row": `section:${key}`,
    "aria-expanded": open,
    onClick: () => toggle(key),
  } as const;
}

export function FoldMark({ open }: { open: boolean }) {
  return <span className="inline-block w-3 text-code-dim">{open ? "▾" : "▸"}</span>;
}
