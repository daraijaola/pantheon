import { test, expect, ready } from './support';
import { wallet, emptyWallet } from './fixtures/data.mjs';
import { uploaded } from './fixtures/uploaded.mjs';

test('Space title stays aligned when the verified session arrives', async ({ page }) => {
  let release!: () => void;
  const session = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/me', async route => {
    await session;
    await route.fulfill({ json: { wallet } });
  });
  await page.route('**/api/me/**', route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1) as keyof typeof uploaded;
    return route.fulfill({ json: uploaded[key] });
  });
  await page.goto('/space');
  await ready(page);
  const title = page.getByRole('heading', { name: 'Your space', exact: true });
  const before = await title.boundingBox();
  release();
  await expect(page.getByText('Only you can see this space.', { exact: true })).toBeVisible();
  await ready(page);
  expect((await title.boundingBox())!.x).toBe(before!.x);
  await expect(title.locator('..').locator('..').locator('svg')).toHaveCount(0);
});

for (const balance of ['empty', 'funded', 'unavailable']) {
  test(`Space empty bag and ${balance} PNTH balance`, async ({ page }) => {
    await page.route('**/api/auth/me', route => route.fulfill({ json: { wallet: balance === 'funded' ? wallet : emptyWallet } }));
    await page.route('**/api/me/**', route => {
      const key = new URL(route.request().url()).pathname.split('/').at(-1) as keyof typeof uploaded;
      const json = key === 'bag' ? { ...uploaded.bag, coins: [], counts: {} }
        : key === 'stake' ? { ...uploaded.stake, staked: { raw: '0', amount: '0' } }
        : uploaded[key];
      return route.fulfill({ json });
    });
    if (balance === 'unavailable') await page.route('**/rpc', route => {
      const data = route.request().postDataJSON();
      const error = (call: { id: number }) => ({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'Balance unavailable' } });
      return route.fulfill({ json: Array.isArray(data) ? data.map(error) : error(data) });
    });
    await page.goto('/space');
    await ready(page);
    const bag = page.getByRole('region', { name: 'Your bag', exact: true });
    await expect(bag.getByText('Nothing here yet.', { exact: true })).toBeVisible();
    await expect(bag.getByRole('link', { name: 'Get PNTH', exact: true })).toHaveAttribute('href', '/get');
    await expect(bag.locator('[class*="ghosts"]')).toHaveCount(0);
    await expect.poll(async () => (await bag.boundingBox())!.height).toBeLessThan(200);
    const now = page.locator('aside').getByRole('link');
    if (balance === 'empty') {
      await expect(now).toHaveText(['Get PNTH', 'Stake', 'Get one']);
      await expect(now.first()).toHaveAttribute('href', '/get');
    } else {
      await expect(now).toHaveText(['Stake', 'Get one']);
    }
    if (page.viewportSize()!.width > 1023) {
      const panel = page.locator('aside > section').first();
      await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThan(350);
    }
  });
}
