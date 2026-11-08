import { test, expect, ready, installWallet } from './support';

for (const path of ['/stake', '/passport/get', '/passport/me', '/get', '/trials/vote', '/space']) {
  test(`Local connect works on ${path}`, async ({ page }) => {
    await installWallet(page);
    await page.goto(path);
    await ready(page);
    const button = page.locator('main').getByRole('button', { name: 'Connect wallet', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toHaveCount(0);
    await expect(page).toHaveURL(`http://127.0.0.1:4173${path}`);
  });
}
