import { test, expect } from './support';
import { token } from './fixtures/data.mjs';

test('Every missing or invalid dispute field explains why Send is disabled', async ({ page }) => {
  await page.route('**/api/delphi/v1/dispute', async route => {
    expect(route.request().postDataJSON()).toEqual({ token: token.toLowerCase(), contact: '@me', message: 'Evidence in the chain.' });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/delphi/dispute');
  const send = page.getByRole('button', { name: 'Send dispute' });
  await expect(send).toBeDisabled();
  await expect(page.getByText('Enter the coin address.', { exact: true })).toBeVisible();
  await expect(page.getByText(/Add a contact with at least 2/)).toBeVisible();
  await expect(page.getByText(/Add at least 10 characters/)).toBeVisible();
  await page.getByLabel('Coin address', { exact: true }).fill('not-an-address');
  await expect(page.getByText(/Enter a valid coin address/)).toBeVisible();
  await page.getByLabel('Coin address', { exact: true }).fill(token);
  await page.getByPlaceholder('@you').fill('@me');
  await page.locator('textarea').fill('short');
  await expect(send).toBeDisabled();
  await page.locator('textarea').fill('Evidence in the chain.');
  await expect(send).toBeEnabled();
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
  await send.click();
  await expect(page.getByText('Received', { exact: true })).toBeVisible();
});

test('Dispute network failure is readable and leaves a retry available', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => String(input).includes('/api/delphi/v1/dispute') ? Promise.reject(new Error('Fixture offline')) : original(input, init);
  });
  await page.goto(`/delphi/dispute?token=${token}`);
  await page.getByPlaceholder('@you').fill('@me');
  await page.locator('textarea').fill('Evidence in the chain.');
  await page.getByRole('button', { name: 'Send dispute' }).click();
  await expect(page.getByRole('alert')).toHaveText("We couldn't reach DELPHI. Try again in a minute.");
  await expect(page.getByRole('button', { name: 'Send dispute' })).toBeEnabled();
});
