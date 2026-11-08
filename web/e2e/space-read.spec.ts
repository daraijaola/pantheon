import { test, expect, ready } from './support';
import { wallet } from './fixtures/data.mjs';
import { uploaded } from './fixtures/uploaded.mjs';

for (const stale of [false, true]) {
  test(`Space shows the saved ${stale ? 'stale' : 'fresh'} read without scanning on every visit`, async ({ page }) => {
    let posts = 0;
    const expensive: string[] = [];
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const readAt = Date.now() - (stale ? 25 * 3600_000 : 3600_000);
    const read = { wallet, readAt, stages: [{ stage: 'wholeBag', ok: true, data: uploaded.bag }, { stage: 'standing', ok: true, data: uploaded.standing }] };
    let state = { read, refreshAfter: 0 };
    await page.route('**/api/auth/me', route => route.fulfill({ json: { wallet } }));
    await page.route('**/api/me/**', async route => {
      const key = new URL(route.request().url()).pathname.split('/').at(-1) as keyof typeof uploaded;
      if (key === 'read') {
        if (route.request().method() === 'POST') { posts++; await waiting; state = { read: { ...read, readAt: Date.now() }, refreshAfter: Date.now() + 600_000 }; }
        return route.fulfill({ json: state });
      }
      if (key === 'bag' || key === 'standing') expensive.push(key);
      return route.fulfill({ json: uploaded[key] });
    });
    await page.goto('/space');
    await ready(page);
    const top = page.getByRole('heading', { name: 'Your space', exact: true }).locator('..');
    await expect(top.getByText(stale ? 'Read 1 day ago' : 'Read 1 h ago', { exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    const refreshButton = page.getByRole('button', { name: 'Refresh', exact: true });
    const readable = async () => {
      await expect(refreshButton).toHaveCSS('color', 'rgb(255, 255, 255)');
      await expect(refreshButton).toHaveCSS('background-image', /linear-gradient/);
      expect(Number(await refreshButton.evaluate(el => getComputedStyle(el).opacity))).toBeGreaterThanOrEqual(0.7);
    };
    if (!stale) await readable();
    const orb = page.getByRole('link', { name: 'Ask DELPHI', exact: true });
    if ((page.viewportSize()?.width ?? 0) > 760) {
      const window = orb.locator('span').last().locator('..');
      await expect(window).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await expect(window).toHaveCSS('box-shadow', 'none');
      await expect(window).toHaveCSS('backdrop-filter', 'none');
      expect(await window.evaluate(el => getComputedStyle(el, '::after').content)).toBe('none');
      await orb.hover();
      await expect(window).toHaveCSS('box-shadow', 'none');
      await page.mouse.move(0, 0);
    } else await expect(orb).toBeHidden();
    await expect(page.getByText('PACT', { exact: true }).first()).toBeVisible();
    expect(expensive).toEqual([]);
    if (stale) await expect.poll(() => posts).toBe(1);
    else { expect(posts).toBe(0); await page.getByRole('button', { name: 'Refresh', exact: true }).click(); }
    release();
    await expect(top.getByText('Read just now', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
    await readable();
    await page.reload();
    await ready(page);
    await expect(top.getByText('Read just now', { exact: true })).toBeVisible();
    expect(posts).toBe(1);
  });
}
