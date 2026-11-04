import { type RefObject, useEffect, useRef, useState } from "react";

// Keyboard control for the deck. Rows carry `data-row` (a session id, or an approval's), the
// open panel carries `data-panel`, and the buttons a key answers carry `data-key` ("y", "n") or
// `data-pick` (numbered 1-9 in on-screen order). A key acts on the highlighted row, or on the
// panel while one is open, and only that one shows its hints, so a key does what its hint says.

export const OPERATOR_INPUT = "operator-input";

/** A key hint on a button. Without `k`, the button's `data-pick` number, filled in by CSS. */
export function KeyHint({ k }: { k?: string }) {
  return k ? <span className="kh">[{k}]</span> : <span className="kh kh-n" />;
}

const KEYMAP: [string, string][] = [
  ["j / ↓", "next row (next session, with its panel open)"],
  ["k / ↑", "previous row"],
  ["g / G", "first / last row"],
  ["enter", "open the row's panel (again to type), or fold a section"],
  ["h / l", "fold the row's section / unfold it"],
  ["i", "type a reply to the row or panel"],
  ["o", "operator input"],
  ["/", "filter"],
  ["y", "approve, or send picked answers"],
  ["n", "deny or skip"],
  ["1-9", "the numbered choices on the row"],
  ["esc", "leave the input; again to close the panel"],
  ["?", "this list"],
  [",", "settings"],
];

function CheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="glow border border-code bg-black p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-widest">Keys</h2>
        <table className="text-sm">
          <tbody>
            {KEYMAP.map(([k, what]) => (
              <tr key={k}>
                <td className="whitespace-nowrap pr-4 font-bold text-white">{k}</td>
                <td className="text-code-dim">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-code-dim">letters and numbers do nothing while you type</p>
      </div>
    </div>
  );
}

const visible = (el: Element) => el.getClientRects().length > 0;
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-row]")].filter(visible);
const rowEl = (id: string) => rows().find((el) => el.dataset.row === id);

// Below the pinned header, and on screen.
function reveal(el: HTMLElement, header: RefObject<HTMLElement | null>) {
  const top = header.current?.getBoundingClientRect().bottom ?? 0;
  const r = el.getBoundingClientRect();
  if (r.top < top || r.bottom > window.innerHeight) {
    window.scrollBy({ top: r.top - top - (window.innerHeight - top - r.height) / 2 });
  }
}

/**
 * The deck's keys. `isSession` says which rows have a panel to open (lone approvals don't).
 * Returns what App draws: the highlight's style and, while it's up, the cheat sheet.
 */
export function useKeys({
  openId,
  open,
  isSession,
  filterBox,
  header,
  modalOpen,
  onSettings,
}: {
  openId: string | null;
  /** Opened by key, so the panel leaves the cursor out of its reply box and j/k keep working. */
  open: (id: string) => void;
  isSession: (id: string) => boolean;
  filterBox: RefObject<HTMLInputElement | null>;
  header: RefObject<HTMLElement | null>;
  /** The settings panel is up, and takes the keys itself. */
  modalOpen: boolean;
  onSettings: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  // Where the highlight was, so a row that drops out of the list hands it to its neighbour.
  const lastIndex = useRef(0);

  // A click on a row highlights it too, so keys pick up where the mouse left off.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const row = (e.target as Element | null)?.closest?.<HTMLElement>("[data-row]");
      if (row?.dataset.row) setSelected(row.dataset.row);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    // Capture, so it runs before the panel's own Escape handler.
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || modalOpen) return;
      const target = e.target as Element | null;
      const typing = target?.closest?.("input, textarea, select, [contenteditable]");

      if (help) {
        if (e.key === "Escape" || e.key === "?") {
          e.preventDefault();
          e.stopPropagation();
          setHelp(false);
        }
        return;
      }

      // Escape is two steps, like vim: out of the box, then out of the panel (SessionDetail
      // closes it, and skips an Escape marked handled here) or off the row.
      if (e.key === "Escape") {
        if (typing) {
          e.preventDefault();
          (target as HTMLElement).blur();
        } else if (!openId) setSelected(null);
        return;
      }
      if (typing) return;

      const list = rows();
      const cur = openId ?? selected;
      const at = cur ? list.findIndex((el) => el.dataset.row === cur) : -1;
      if (at >= 0) lastIndex.current = at;
      const go = (i: number) => {
        // With the panel open, step over rows that have no panel.
        let n = Math.max(0, Math.min(list.length - 1, i));
        const step = i < at ? -1 : 1;
        while (openId && list[n] && !isSession(list[n]!.dataset.row!)) n += step;
        const el = list[n];
        if (!el?.dataset.row) return;
        e.preventDefault();
        setSelected(el.dataset.row);
        if (openId) open(el.dataset.row);
        else reveal(el, header);
      };

      // The panel when it's open, else the highlighted row.
      const scope = openId ? document.querySelector<HTMLElement>("[data-panel]") : at >= 0 ? list[at] : null;
      const focusReply = () => {
        const box = scope?.querySelector<HTMLTextAreaElement>("textarea");
        if (!box) return;
        e.preventDefault();
        box.focus();
      };
      const press = (el: HTMLElement | null | undefined) => {
        if (!el || (el as HTMLButtonElement).disabled) return;
        e.preventDefault();
        el.click();
      };

      switch (e.key) {
        case "j":
        case "ArrowDown":
          // Its row gone from the list, the highlight goes to the one now in its place.
          return go(at >= 0 ? at + 1 : selected ? lastIndex.current : 0);
        case "k":
        case "ArrowUp":
          return go(at >= 0 ? at - 1 : selected ? lastIndex.current - 1 : 0);
        case "g":
          return go(0);
        case "G":
          return go(list.length - 1);
        case "Enter":
          // A focused button or link handles its own Enter.
          if (target && target !== document.body) return;
          // Enter again, in the panel it opened: start typing.
          if (openId) return focusReply();
          if (!selected) return;
          if (isSession(selected)) {
            e.preventDefault();
            open(selected);
          } else if (selected.startsWith("section:")) press(list[at]);
          return;
        case "h": {
          // Fold the section the highlight is in, and highlight its title.
          const head = list[at]?.closest("[data-section]")?.querySelector<HTMLElement>('[data-row^="section:"]');
          if (openId || !head?.dataset.row) return;
          e.preventDefault();
          if (head.getAttribute("aria-expanded") === "true") head.click();
          setSelected(head.dataset.row);
          return;
        }
        case "l": {
          const head = list[at];
          if (openId || !selected?.startsWith("section:") || head?.getAttribute("aria-expanded") !== "false") return;
          return press(head);
        }
        case "/":
          if (openId) return;
          e.preventDefault();
          filterBox.current?.focus();
          return;
        case "o": {
          const box = document.getElementById(OPERATOR_INPUT);
          if (openId || !box) return;
          e.preventDefault();
          box.focus();
          return;
        }
        case "i":
          return focusReply();
        case "?":
          e.preventDefault();
          setHelp(true);
          return;
        case ",":
          e.preventDefault();
          onSettings();
          return;
        case "y":
        case "n":
          return press(scope?.querySelector<HTMLElement>(`[data-key="${e.key}"]`));
      }
      if (/^[1-9]$/.test(e.key)) press(scope?.querySelectorAll<HTMLElement>("[data-pick]")[Number(e.key) - 1]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openId, open, isSession, selected, help, filterBox, header, modalOpen, onSettings]);

  // The highlighted row (or the open panel) shows its key hints.
  const scope = openId ? "[data-panel]" : selected ? `[data-row="${CSS.escape(selected)}"]` : null;
  const style = (
    <style>
      {scope && `${scope} .kh { display: inline; }`}
      {!openId && selected && `[data-row="${CSS.escape(selected)}"] { outline: 2px solid #fff; outline-offset: 1px; }`}
    </style>
  );
  const sheet = help ? <CheatSheet onClose={() => setHelp(false)} /> : null;
  return { overlay: <>{style}{sheet}</>, showHelp: () => setHelp(true) };
}
