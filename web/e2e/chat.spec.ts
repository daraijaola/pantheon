import { test, expect, ready } from './support';

test('Answer waits until the thinking line is invisible', async ({ page }) => {
  await page.goto('/delphi/chat');
  await ready(page);
  await page.evaluate(() => {
    const state = { overlap: false, sawThink: false, sawAnswer: false };
    Object.assign(window, { revealState: state });
    const sample = () => {
      const think = document.querySelector('[class*="think_"]');
      const answer = document.querySelector('[class*="answer_"]');
      const thinking = !!think && Number(getComputedStyle(think).opacity) > 0.01;
      const answering = !!answer?.textContent && Number(getComputedStyle(answer).opacity) > 0.01;
      state.sawThink ||= thinking;
      state.sawAnswer ||= answering;
      state.overlap ||= thinking && answering;
      if (!state.sawAnswer) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: 'Is PACT clean?', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { revealState: { sawAnswer: boolean } }).revealState.sawAnswer)).toBe(true);
  const state = await page.evaluate(() => (window as unknown as { revealState: { overlap: boolean; sawThink: boolean } }).revealState);
  expect(state.sawThink).toBe(true);
  expect(state.overlap).toBe(false);
});

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
