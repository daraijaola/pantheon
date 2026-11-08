import { test, expect, ready } from './support';
import { token } from './fixtures/data.mjs';

for (const [address, title] of [['not-an-address', 'Not a valid address'], ['0x1111111111111111111111111111111111111111', 'Not scanned yet']]) {
  test(`Missing report: ${title}`, async ({ page }) => {
    await page.goto(`/delphi/${address}`);
    await ready(page);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to DELPHI', exact: true })).toHaveAttribute('href', '/delphi');
    await expect(page.getByRole('link', { name: 'Ask DELPHI', exact: true })).toHaveAttribute('href', '/delphi/chat');
    await expect(page.getByRole('link', { name: 'PANTHEON home', exact: true })).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
}

test('Known reports still render inside the normal shell', async ({ page }) => {
  const response = await page.goto(`/delphi/${token}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: /PACT/ }).first()).toBeVisible();
});
