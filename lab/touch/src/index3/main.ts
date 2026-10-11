import { BasketScene, BurnScene, MONO, SplitScene, type Scene } from "./scenes";

const W = 306;
const H = 200;
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const scenes: [CanvasRenderingContext2D, Scene][] = [];

document.fonts.load(`400 12px ${MONO}`).catch(() => []).then(() => {
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas[data-scene]")) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const kind = canvas.dataset.scene;
    scenes.push([ctx, kind === "split" ? new SplitScene(W, H) : kind === "basket" ? new BasketScene(W, H) : new BurnScene(W, H)]);
  }
  const loop = (now: number) => {
    for (const [ctx, s] of scenes) s.draw(ctx, now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
