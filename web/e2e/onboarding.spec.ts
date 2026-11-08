import { test, expect, connect, ready } from './support';
import { wallet } from './fixtures/data.mjs';
import { uploaded } from './fixtures/uploaded.mjs';

test.use({ ignoreHTTPSErrors: true });

for (const entry of ['upload', 'home']) {
  test(`Returning SIWE session skips the upload reading from ${entry}`, async ({ page }) => {
    await page.route('**/api/auth/me', route => route.fulfill({ json: { wallet } }));
    await page.route('**/api/me/**', route => {
      const key = new URL(route.request().url()).pathname.split('/').at(-1) as keyof typeof uploaded;
      return route.fulfill({ json: key === 'read' ? { read: { wallet, readAt: Date.now(), stages: [] }, refreshAfter: Date.now() + 600_000 } : uploaded[key] });
    });
    await page.goto(entry === 'home' ? '/' : '/upload');
    await ready(page);
    if (entry === 'home') await page.locator('main').getByRole('button', { name: /^Get uploaded/ }).first().click();
    await expect(page).toHaveURL('http://127.0.0.1:4173/space');
    await expect(page.getByRole('heading', { name: 'Your space', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue \(bubble/ })).toHaveCount(0);
  });
}

test('Audit F01: homepage Get uploaded opens onboarding', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.locator('main').getByRole('button', { name: /^Get uploaded/ }).first().click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/upload');
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
});

test('Header/menu Get uploaded opens onboarding', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  if ((page.viewportSize()?.width ?? 0) <= 900) {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.locator('nav[aria-label="Explore"]').getByRole('button', { name: 'Get uploaded', exact: true }).click();
  } else await page.locator('header').getByRole('button', { name: 'Get uploaded', exact: true }).first().click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/upload');
});

test('Verified SIWE and completed bubble animation land on the wallet space', async ({ page }) => {
  test.setTimeout(90_000);
  await connect(page, undefined, true, 'https://127.0.0.1:4176');
  const verified = page.waitForResponse(response => response.url().endsWith('/api/auth/verify'));
  await page.getByRole('button', { name: 'Sign message', exact: true }).click();
  expect((await verified).status()).toBe(200);
  await expect(page).toHaveURL('https://127.0.0.1:4176/upload');
  const bubble = page.getByRole('button', { name: 'Continue (bubble 1 of 7)', exact: true });
  const fallback = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(bubble.or(fallback)).toBeVisible({ timeout: 40_000 });
  await bubble.or(fallback).click({ force: true });
  await expect(page).toHaveURL('https://127.0.0.1:4176/space');
  await expect(page.getByRole('heading', { name: 'Your space', exact: true })).toBeVisible();
  await expect(page.getByText('Only you can see this space.', { exact: true })).toBeVisible();
  await expect(page.getByText('PACT', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Couldn’t read it', { exact: true })).toHaveCount(0);
});
