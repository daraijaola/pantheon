import { test, expect, ready } from './support';

test('PR 10: New chat then reload keeps mobile composer below the orb slot', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'Mobile composer regression');
  await page.goto('/delphi/chat');
  await ready(page);
  await page.getByRole('button', { name: 'Is PACT clean?', exact: true }).click();
  await expect(page.getByText('PACT passed the fixture checks.', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.reload();
  await ready(page);
  await expect(page.getByRole('heading', { name: 'Ask DELPHI about any coin.', exact: true })).toBeVisible();
  const heading = await page.getByRole('heading', { name: 'Ask DELPHI about any coin.', exact: true }).boundingBox();
  const composer = await page.locator('[data-composer]').boundingBox();
  const orbSlot = await page.locator('[class*="heroSpot"]').boundingBox();
  expect(heading).not.toBeNull();
  expect(composer).not.toBeNull();
  expect(orbSlot).not.toBeNull();
  expect(composer!.y).toBeGreaterThan(heading!.y + heading!.height);
  expect(composer!.y).toBeGreaterThan(orbSlot!.y + orbSlot!.height);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await expect(page.getByText('Reading the chain…', { exact: true })).toHaveCount(0);
});
