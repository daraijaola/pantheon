import { test, expect, ready, connect } from './support';

test('Disconnected stake has one rewards prompt and public totals below the task', async ({ page }) => {
  await page.goto('/stake');
  await ready(page);
  await expect(page.getByText('Your rewards appear once your wallet is connected.')).toBeVisible();
  const main = page.locator('main section').first();
  await expect(main.locator('ul')).toHaveCount(0);
  const task = await main.boundingBox();
  const totals = await page.locator('main aside').boundingBox();
  expect(totals!.y).toBeGreaterThanOrEqual(task!.y + task!.height - 1);
});

test('Connected stake still renders earned rewards', async ({ page }) => {
  await connect(page, '/stake');
  await expect(page.getByText('Your rewards appear once your wallet is connected.')).toHaveCount(0);
  await expect(page.locator('main section').first().locator('ul li').first()).toBeVisible();
});
