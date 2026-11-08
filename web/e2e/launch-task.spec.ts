import { test, expect, ready } from './support';
import { mockRpc } from './rpc-state';

test('Paused launch explains the prerequisite before a disabled form', async ({ page }) => {
  await mockRpc(page, { paused: true });
  await page.goto('/covenant/launch');
  await ready(page);
  const notice = page.getByRole('status').filter({ hasText: 'Launches are paused by Ascend' });
  await expect(notice).toBeVisible();
  const form = page.locator('fieldset');
  const rects = [await notice.boundingBox(), await form.boundingBox()];
  expect(rects[0]!.y + rects[0]!.height).toBeLessThanOrEqual(rects[1]!.y);
  for (const input of await form.locator('input, select, button').all()) await expect(input).toBeDisabled();
});
