import { test, expect, ready, installWallet } from './support';

for (const path of ['/stake', '/passport/get', '/passport/me', '/get', '/trials/vote', '/space', '/covenant/launch']) {
  test(`Local connect works on ${path}`, async ({ page }) => {
    await installWallet(page);
    await page.goto(path);
    await ready(page);
    const scope = path === '/space' ? page.getByRole('region', { name: 'Now', exact: true }) : page.locator('main');
    const button = scope.getByRole('button', { name: 'Connect wallet', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(button).toHaveCount(0);
    await expect(page).toHaveURL(`http://127.0.0.1:4173${path}`);
  });
}

test('Local connection cancellation explains the error and allows retry', async ({ page }) => {
  await installWallet(page);
  await page.goto('/stake');
  await ready(page);
  await page.evaluate(() => {
    const provider = (window as unknown as { ethereum: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } }).ethereum;
    const original = provider.request.bind(provider);
    provider.request = args => args.method === 'eth_requestAccounts' ? Promise.reject(new Error('User rejected request')) : original(args);
  });
  const button = page.locator('main').getByRole('button', { name: 'Connect wallet', exact: true });
  await button.click();
  await expect(page.locator('main').getByRole('alert')).toHaveText('You cancelled it in your wallet.');
  await expect(button).toBeEnabled();
});
