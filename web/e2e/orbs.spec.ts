import { test, expect, ready } from './support';

const surfaces = [
  { path: '/', canvas: 'main button canvas', fallback: 'main button [class*="bead"]' },
  { path: '/space', canvas: 'a[aria-label="Ask DELPHI"] canvas', fallback: 'a[aria-label="Ask DELPHI"] [class*="delphiBead"]' },
  { path: '/delphi/chat', canvas: 'canvas[class*="orb"]', fallback: '[class*="bead"]' },
];

for (const surface of surfaces) {
  test(`WebGL loss and restore resumes painted frames on ${surface.path}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Controlled SwiftShader context loss');
    test.skip(surface.path === '/space' && page.viewportSize()!.width <= 760, 'Phone uses the labelled DELPHI tab');
    await page.addInitScript(() => {
      const draw = WebGLRenderingContext.prototype.drawArrays;
      WebGLRenderingContext.prototype.drawArrays = function (...args) {
        draw.apply(this, args);
        const [x, y, w, h] = this.getParameter(this.SCISSOR_BOX) as Int32Array;
        const pixel = new Uint8Array(4);
        this.readPixels(Math.floor(x + w / 2), Math.floor(y + h / 2), 1, 1, this.RGBA, this.UNSIGNED_BYTE, pixel);
        if (pixel[3] && this.getError() === this.NO_ERROR) {
          const canvas = this.canvas as HTMLCanvasElement;
          canvas.dataset.paints = String(Number(canvas.dataset.paints ?? 0) + 1);
        }
      };
    });
    await page.goto(surface.path);
    await ready(page);
    const canvas = page.locator(surface.canvas).first();
    const paints = async () => Number(await canvas.getAttribute('data-paints') ?? 0);
    await expect.poll(paints).toBeGreaterThan(1);
    await canvas.evaluate(element => {
      const canvas = element as HTMLCanvasElement & { loss?: WEBGL_lose_context };
      const loss = canvas.getContext('webgl')!.getExtension('WEBGL_lose_context');
      if (!loss) throw new Error('WEBGL_lose_context required');
      canvas.loss = loss;
      loss.loseContext();
    });
    await expect(page.locator(surface.fallback).first()).toBeVisible();
    const before = await paints();
    await canvas.evaluate(element => (element as HTMLCanvasElement & { loss: WEBGL_lose_context }).loss.restoreContext());
    await expect.poll(paints).toBeGreaterThan(before + 1);
    await expect(page.locator(surface.fallback).first()).not.toBeVisible();
  });

  test(`WebGL unavailable shows a static orb on ${surface.path}`, async ({ page }) => {
    test.skip(surface.path === '/space' && page.viewportSize()!.width <= 760, 'Phone uses the labelled DELPHI tab');
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        value: function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
          return type === 'webgl' ? null : Reflect.apply(original, this, [type, ...args]);
        },
      });
    });
    await page.goto(surface.path);
    await ready(page);
    await expect(page.locator(surface.fallback).first()).toBeVisible();
  });
}
