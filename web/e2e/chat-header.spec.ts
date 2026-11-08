import { test, expect, connect, ready } from './support';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.0.${info.workerIndex + 1}` });
});

test('Chat controls stay below the app header, including on reload and while chatting', async ({ page }) => {
  await connect(page, '0x1');
  await page.goto('/delphi/chat');
  for (const state of ['empty', 'active', 'reload']) {
    if (state === 'active') {
      await page.getByRole('button', { name: 'Is PACT clean?', exact: true }).click();
      await expect(page.getByText('PACT passed the fixture checks.', { exact: false }).first()).toBeVisible();
    }
    if (state === 'reload') await page.reload();
    await ready(page);
    const header = await page.locator('header').filter({ has: page.getByRole('button', { name: 'Create', exact: true }) }).boundingBox();
    const control = page.getByRole('button', { name: 'New chat', exact: true });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
});
