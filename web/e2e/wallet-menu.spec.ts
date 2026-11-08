import { test, expect, connect, ready } from './support';
import { wallet } from './fixtures/data.mjs';

test.use({ hasTouch: true, isMobile: true });
test.skip(({ browserName, viewport }) => browserName === 'firefox' || (viewport?.width ?? 0) > 390, 'Chromium and WebKit phone touch menus');

for (const blurOnTap of [false, true]) {
  test(`Phone wallet menu supports item taps${blurOnTap ? ' with null blur' : ''}`, async ({ page }) => {
    await page.addInitScript(({ blurOnTap }) => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { Object.assign(window, { copiedWalletAddress: text }); },
      } });
      // Exercise touch focus loss without a relatedTarget.
      if (blurOnTap) document.addEventListener('pointerdown', event => {
        const trigger = document.querySelector('button[aria-label^="Your wallet"]');
        const panel = document.getElementById(trigger?.getAttribute('aria-controls') ?? '');
        if (event.target instanceof Node && panel?.contains(event.target) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }, true);
    }, { blurOnTap });
    await connect(page);
    await page.goto('/stake');
    await ready(page);
    const trigger = page.getByRole('button', { name: /^Your wallet/ });
    await trigger.tap();
    const passport = page.getByRole('link', { name: 'Your Passport', exact: true });
    await expect(passport).toBeVisible();
    const panel = passport.locator('..');
    const bounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await passport.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })).toBe(true);
    await passport.tap();
    await expect(page).toHaveURL(/\/passport\/me$/);
    await trigger.tap();
    await page.getByRole('button', { name: 'Copy address', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { copiedWalletAddress: string }).copiedWalletAddress)).toBe(wallet);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).tap();
    await expect(page.getByRole('button', { name: /^Your wallet/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Get uploaded', exact: true }).first()).toBeVisible();
  });
}

test('Phone wallet menu closes on outside taps, Escape and keyboard focus leaving', async ({ page }) => {
  await connect(page);
  await page.goto('/stake');
  await ready(page);
  const trigger = page.getByRole('button', { name: /^Your wallet/ });
  await trigger.tap();
  await page.getByRole('heading', { name: 'Stake PNTH', exact: true }).tap({ position: { x: 4, y: 4 } });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.tap();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await trigger.tap();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
