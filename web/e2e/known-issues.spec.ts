import { test, expect } from './support';

test.fixme('Audit F01: homepage Get uploaded still says Opening soon instead of navigating', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Get uploaded/ }).first().click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/upload');
});
