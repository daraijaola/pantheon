import { test, expect, ready, connect } from './support';
import { mockRpc } from './rpc-state';
import { token } from './fixtures/data.mjs';

test('Disconnected stake has one rewards prompt and public totals below the task', async ({ page }) => {
  await mockRpc(page, { rewardTokens: Array.from({ length: 13 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`) });
  await page.goto('/stake');
  await ready(page);
  await expect(page.getByText('Your rewards appear once your wallet is connected.')).toBeVisible();
  await expect(page.locator('main aside').getByText('Coins streaming', { exact: true }).locator('..')).toContainText('13');
  const main = page.locator('main section').first();
  await expect(main.locator('ul')).toHaveCount(0);
  const task = await main.boundingBox();
  const totals = await page.locator('main aside').boundingBox();
  expect(totals!.y).toBeGreaterThanOrEqual(task!.y + task!.height - 1);
});

test('Connected stake still renders earned rewards', async ({ page }) => {
  await mockRpc(page, { rewardTokens: [token] });
  await connect(page);
  await page.goto('/stake');
  await expect(page.getByText('Your rewards appear once your wallet is connected.')).toHaveCount(0);
  await expect(page.locator('main section').first().locator('ul li').first()).toBeVisible();
});
