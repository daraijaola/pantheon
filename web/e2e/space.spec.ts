import { test, expect, ready } from './support';
import { wallet, emptyWallet, token } from './fixtures/data.mjs';
import { uploaded } from './fixtures/uploaded.mjs';

for (const urgent of ['alert', 'claim', 'vote', 'all']) {
  test(`Zero PNTH keeps ${urgent} urgent actions ahead of onboarding`, async ({ page }) => {
    const has = (kind: string) => urgent === kind || urgent === 'all';
    const data = {
      ...uploaded,
      stake: { ...uploaded.stake, staked: { raw: '0', amount: '0' } },
      guard: { ...uploaded.guard, alerts: has('alert') ? [{ id: 'flag', kind: 'verdict-drop', token, symbol: 'PACT', venue: 'ascend', at: uploaded.guard.readAt, from: 'CLEAN', to: 'FLAG', reason: 'Fixture flag', evidence: [], reportUrl: `/delphi/${token}`, disputeUrl: '/delphi/dispute' }] : [] },
      rewards: { ...uploaded.rewards, coins: has('claim') ? [{ token, symbol: 'PNTH', claimable: { raw: '1000000000000000000', amount: '1' }, claimed: null, earned: null, verdict: null }] : [] },
      ballot: { ...uploaded.ballot, round: 5, canVote: has('vote'), votes: 1, closesAt: '2099-01-01T00:00:00Z' },
    };
    await page.route('**/api/auth/me', route => route.fulfill({ json: { wallet: emptyWallet } }));
    await page.route('**/api/me/**', route => route.fulfill({ json: data[new URL(route.request().url()).pathname.split('/').at(-1) as keyof typeof data] }));
    await page.goto('/space');
    await ready(page);
    const titles = page.getByRole('region', { name: 'Now', exact: true }).getByRole('listitem').locator('strong');
    const expected = [has('alert') && 'PACT was flagged', has('claim') && '1 PNTH to claim', has('vote') && 'Round 5 is open', 'Get PNTH', 'Earn from the basket', 'Get your passport'].filter((value): value is string => typeof value === 'string').slice(0, 3);
    await expect(titles).toHaveText(expected);
  });
}

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
    let failedReads = 0;
    if (balance === 'unavailable') await page.route('**/rpc', route => {
      failedReads++;
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
    const now = page.getByRole('region', { name: 'Now', exact: true }).getByRole('link');
    if (balance === 'empty') {
      await expect(now.locator('strong')).toHaveText(['Get PNTH', 'Earn from the basket', 'Get your passport']);
      await expect(now.first()).toHaveAttribute('href', '/get');
    } else {
      if (balance === 'unavailable') await expect.poll(() => failedReads).toBeGreaterThan(0);
      await expect(now.locator('strong')).toHaveText(['Earn from the basket', 'Get your passport']);
    }
    if (page.viewportSize()!.width > 1023) {
      const panel = page.locator('aside > section').first();
      await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThan(350);
    }
  });
}
