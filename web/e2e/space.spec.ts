import { test, expect, ready } from './support';
import { wallet } from './fixtures/data.mjs';
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
