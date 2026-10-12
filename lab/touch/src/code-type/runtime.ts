// Shared helpers for the canvas code effects.

/** Glyphs shown while a character is still "encrypted". */
export const SCRAMBLE = "{}[]()<>/\\|=+-*&%$#@!?;:0123456789abcdefx";

export const randomGlyph = () => SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];

export const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The mono family next/font registered on <html> (falls back to the system mono). */
export function monoFamily(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim();
  return v || "ui-monospace, monospace";
}

export function cssColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Character advance as a fraction of the font size (Geist Mono ≈ 0.6). */
export function advanceRatio(ctx: CanvasRenderingContext2D, family: string, weight: number): number {
  ctx.font = `${weight} 100px ${family}`;
  return ctx.measureText("M").width / 100 || 0.6;
}

/** Size a canvas for the device pixel ratio and return its 2D context in CSS pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Calls onChange(true/false) as the element enters/leaves the viewport or the tab is hidden. */
export function watchActive(el: Element, onChange: (active: boolean) => void): () => void {
  let inView = true;
  const emit = () => onChange(inView && document.visibilityState === "visible");
  const io = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    emit();
  });
  io.observe(el);
  document.addEventListener("visibilitychange", emit);
  return () => {
    io.disconnect();
    document.removeEventListener("visibilitychange", emit);
  };
}
