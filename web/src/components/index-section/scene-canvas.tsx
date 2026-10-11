"use client";

import { useEffect, useRef } from "react";
import { fitCanvas, monoFamily, prefersReducedMotion, watchActive } from "../code-type/runtime";
import { BasketScene, BurnScene, setMono, SplitScene, type Scene } from "./scenes";

const W = 306;
const H = 200;
const SCENES = { split: SplitScene, basket: BasketScene, burn: BurnScene };

/** One small animated scene. Runs only while on screen; holds a single still frame for reduced motion. */
export function SceneCanvas({ kind, className }: { kind: keyof typeof SCENES; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduce = prefersReducedMotion();
    const ctx = fitCanvas(canvas, W, H);
    let scene: Scene | null = null;
    let raf = 0;
    let active = false;

    const loop = (now: number) => {
      raf = 0;
      if (!active || !scene) return;
      scene.draw(ctx, now);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (!raf && active && scene && !reduce) raf = requestAnimationFrame(loop);
    };

    let cancelled = false;
    document.fonts
      .load(`400 12px ${monoFamily()}`)
      .catch(() => [])
      .then(() => {
        if (cancelled) return;
        setMono(monoFamily());
        scene = new SCENES[kind](W, H);
        // Reduced motion: one representative still frame, no loop.
        if (reduce) scene.draw(ctx, performance.now() + 2600);
        start();
      });

    const stop = watchActive(canvas, (on) => {
      active = on;
      start();
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stop();
    };
  }, [kind]);

  return <canvas ref={ref} aria-hidden="true" width={W} height={H} className={className} style={{ width: W, height: H }} />;
}
