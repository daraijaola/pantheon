import { FlowScene, SCENE_H, SCENE_W } from "./scene";

const FAMILY = '"Geist Mono", ui-monospace, monospace';
const canvas = document.querySelector<HTMLCanvasElement>("#flow")!;
const slider = document.querySelector<HTMLInputElement>("#reveal")!;
const fpsEl = document.querySelector<HTMLElement>("#fps")!;
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = SCENE_W * dpr;
canvas.height = SCENE_H * dpr;
canvas.style.width = `${SCENE_W}px`;
canvas.style.height = `${SCENE_H}px`;
const ctx = canvas.getContext("2d")!;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

let scene = new FlowScene(FAMILY);
let auto = true; // autoplay the reveal like a scroll would
let autoT0 = performance.now();
const AUTO_MS = 3600;

slider.oninput = () => {
  auto = false;
  scene.reveal = Math.max(scene.reveal, Number(slider.value));
};
document.querySelector<HTMLButtonElement>("#replay")!.onclick = () => {
  scene = new FlowScene(FAMILY);
  auto = true;
  autoT0 = performance.now();
};

let last = performance.now();
let frames = 0;
let fpsT = last;
function loop(now: number) {
  const dt = now - last;
  last = now;
  if (auto) {
    const t = Math.min(1, (now - autoT0) / AUTO_MS);
    scene.reveal = t;
    slider.value = String(t);
  }
  scene.update(now, dt, scene.reveal >= 0.98);
  scene.draw(ctx, now, "#171717");
  frames++;
  if (now - fpsT > 1000) {
    fpsEl.textContent = `${frames} fps`;
    frames = 0;
    fpsT = now;
  }
  requestAnimationFrame(loop);
}
document.fonts.load(`400 12px ${FAMILY}`).catch(() => []).then(() => requestAnimationFrame(loop));
Object.assign(window, { flow: { get scene() { return scene; } } });
