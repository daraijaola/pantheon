import { test, expect, ready } from './support';

const destinations = ['/passport', '/trials', '/covenant', '/delphi', '/terms', '/#basket', '/get'];
for (const href of destinations) {
  test(`Explore menu link ${href} resolves`, async ({ page }) => {
    await page.goto('/');
    await ready(page);
    const trigger = page.getByRole('button', { name: (page.viewportSize()?.width ?? 0) > 900 ? 'Explore' : 'Open menu', exact: true });
    await trigger.click();
    const menu = page.locator('nav[aria-label="Explore"]');
    await expect(menu).toBeVisible();
    if (href === '/get' && (page.viewportSize()?.width ?? 0) > 900) {
      // The menu's Get PNTH action is mobile-only; desktop uses the hero link.
      await page.keyboard.press('Escape');
      await page.locator('main a[href="/get"]').first().click();
    } else await menu.locator(`a[href="${href}"]`).click();
    await expect(page).toHaveURL(`http://127.0.0.1:4173${href}`);
    await ready(page);
    await expect(menu).not.toBeVisible();
    await expect(page.locator('body')).not.toContainText('This page could not be found');
    if (href.includes('#')) await expect(page.locator('#basket')).toBeAttached();
  });
}

for (const href of ['/delphi/chat', '/stake', '/trials/vote']) {
  test(`Visible app navigation link ${href} resolves`, async ({ page }) => {
    await page.goto('/stake');
    await ready(page);
    await page.locator('nav[aria-label="App"]:visible').locator(`a[href="${href}"]`).click();
    await expect(page).toHaveURL(`http://127.0.0.1:4173${href}`);
    await ready(page);
  });
}

test('Create link resolves to launch', async ({ page }) => {
  await page.goto('/stake');
  await ready(page);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('link', { name: 'Launch a coin', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/covenant/launch');
});
