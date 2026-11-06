import { useEffect, useRef } from "react";

const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:.=*+-<>¦";
const SIZE = 16;
const BURST_MS = 3000;
// With nothing waiting on you, the rain falls at a third of its speed.
const CALM_EVERY = 3;

// The cockpit's pixel font has no katakana.
const HUD_GLYPHS = "0123456789ABCDEF#%*+-<>";

export const randomGlyph = () => {
  const from = document.documentElement.dataset.theme === "hud" ? HUD_GLYPHS : GLYPHS;
  return from[Math.floor(Math.random() * from.length)] ?? "0";
};

/**
 * Digital rain behind the operator. Dim on purpose so the rows stay readable. `burst` counts
 * shipped moments: each new value turns it purple and bright for a few seconds.
 */
export function MatrixRain({ calm, burst }: { calm: boolean; burst: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const calmRef = useRef(calm);
  calmRef.current = calm;
  const burstUntil = useRef(0);
  const lastBurst = useRef(burst);

  useEffect(() => {
    if (burst === lastBurst.current) return;
    lastBurst.current = burst;
    burstUntil.current = Date.now() + BURST_MS;
    ref.current?.style.setProperty("opacity", "0.7");
    const fade = setTimeout(() => ref.current?.style.removeProperty("opacity"), BURST_MS);
    return () => clearTimeout(fade);
  }, [burst]);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let drops: number[] = [];
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      drops = Array.from({ length: Math.ceil(canvas.width / SIZE) }, () => Math.random() * -50);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    resize();
    window.addEventListener("resize", resize);

    let frame = 0;
    const tick = setInterval(() => {
      frame += 1;
      const bursting = Date.now() < burstUntil.current;
      if (calmRef.current && !bursting && frame % CALM_EVERY !== 0) return;
      ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${SIZE}px ui-monospace, monospace`;
      drops.forEach((y, i) => {
        // Leading glyph is near-white, the trail fades to green (purple while something ships).
        ctx.fillStyle = Math.random() > 0.96 ? "#d6ffdf" : bursting ? "#b48cff" : "#00ff41";
        ctx.fillText(randomGlyph(), i * SIZE, y * SIZE);
        drops[i] = y * SIZE > canvas.height && Math.random() > 0.975 ? 0 : y + 1;
      });
    }, 55);

    return () => {
      clearInterval(tick);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 -z-10 opacity-25 transition-opacity duration-700" />;
}
