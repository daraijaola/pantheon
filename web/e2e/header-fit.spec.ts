import { test, expect, connect, ready } from './support';

const routes = ['/space', '/stake', '/delphi/chat', '/trials/vote', '/passport/get', '/passport/me', '/covenant/launch'];

for (const chain of ['0x1', '0x185d9']) {
  test(`phone header fits with ${chain === '0x1' ? 'wrong-chain' : 'connected'} wallet`, async ({ page }) => {
    test.setTimeout(90_000);
    test.skip((page.viewportSize()?.width ?? 0) > 390, 'Phone geometry');
    await connect(page, chain);
    for (const route of routes) {
      await page.goto(route);
      await ready(page);
      const header = page.locator('header').filter({ has: page.getByRole('link', { name: 'PANTHEON, back to the site' }) });
      const wallet = header.getByRole('button', { name: chain === '0x1' ? 'Switch to Elysium' : /^Your wallet/ });
      await expect(wallet).toBeVisible();
      const boxes = await Promise.all([header, header.getByRole('link', { name: 'PANTHEON, back to the site' }), header.getByRole('button', { name: 'Create', exact: true }), wallet].map(el => el.boundingBox()));
      const [bar, ...items] = boxes;
      expect(bar).not.toBeNull();
      for (const box of items) {
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box!.y).toBeGreaterThanOrEqual(bar!.y);
        expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
      }
      expect(items[0]!.x + items[0]!.width).toBeLessThanOrEqual(items[1]!.x);
      expect(items[1]!.x + items[1]!.width).toBeLessThanOrEqual(items[2]!.x);
      expect(await wallet.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.waitForLoadState('networkidle');
    }
  });
}
