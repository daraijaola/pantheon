import { test, expect, ready } from './support';
import { mockRpc } from './rpc-state';

test('Sold-out pool hides alternate buying and test-USDC controls but keeps the faucet', async ({ page }) => {
  await mockRpc(page, { balanceOf: 0n });
  await page.goto('/get');
  await ready(page);
  await expect(page.getByText(/Sold out|nothing left|pool.*empty/i).first()).toBeVisible();
  await expect(page.getByText('Buy a different amount', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Make.*USDC/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Faucet ↗', exact: true })).toBeVisible();
});

test('Stocked pool retains alternate purchase controls', async ({ page }) => {
  await page.goto('/get');
  await ready(page);
  await expect(page.getByText('Buy a different amount', { exact: true })).toBeVisible();
  await page.getByText('Buy a different amount', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Make 1,000 test USDC' })).toBeVisible();
});
