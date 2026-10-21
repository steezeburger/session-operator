// The tab icon: a ">_" prompt over a bit of falling code. Green when all's quiet, amber when
// something needs you, so the tab says it without switching to it.
const RAIN = [
  [22, 4, 0.9],
  [22, 8, 0.5],
  [22, 12, 0.25],
  [26, 6, 0.7],
  [26, 10, 0.35],
  [26, 14, 0.15],
] as const;

function svg(color: string) {
  const drops = RAIN.map(([x, y, o]) => `<rect x="${x}" y="${y}" width="2.5" height="2.5" fill="${color}" opacity="${o}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#000"/>
<rect x="1" y="1" width="30" height="30" rx="5" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="1.5"/>
${drops}
<polyline points="6,9 13,16 6,23" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="square"/>
<rect x="15" y="20" width="10" height="3.5" fill="${color}"/>
</svg>`;
}

const ICONS = {
  quiet: `data:image/svg+xml,${encodeURIComponent(svg("#00ff41"))}`,
  needs: `data:image/svg+xml,${encodeURIComponent(svg("#ffb000"))}`,
};

/** Points the tab icon and title at how many sessions need you. */
export function setFavicon(needs: number) {
  let link = document.querySelector<HTMLLinkElement>("link[rel=icon]");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    document.head.appendChild(link);
  }
  const href = needs > 0 ? ICONS.needs : ICONS.quiet;
  if (link.href !== href) link.href = href;
  document.title = needs > 0 ? `(${needs}) Session operator` : "Session operator";
}
