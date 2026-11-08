import { test, expect, ready } from './support';

test('Trials landing uses the current server round, with truthful CTA and collapsed rules', async ({ page }) => {
  await page.goto('/trials');
  await ready(page);
  await expect(page.getByRole('link', { name: 'Vote now', exact: true })).toHaveAttribute('href', '/trials/vote');
  await expect(page.getByRole('region', { name: 'Current round' })).toContainText('Round 1 open');
  await expect(page.getByText('EXAMPLE', { exact: true })).toHaveCount(0);
  await expect(page.locator('#details > details')).not.toHaveAttribute('open');
  await page.getByText('Rules', { exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
});
