import { test, expect, ready } from './support';
import { token } from './fixtures/data.mjs';

test('Completed answers do not depend on animation frames', async ({ page }) => {
  await page.goto('/delphi/chat');
  await ready(page);
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await page.getByRole('button', { name: 'Is PACT clean?', exact: true }).click();
  await expect(page.getByText('PACT passed the fixture checks.', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test('Answer waits until the thinking line is invisible', async ({ page }) => {
  await page.addInitScript(({ token }) => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (!String(input).includes('/api/ask-delphi')) return original(input, init);
      const encoder = new TextEncoder();
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'coins', coins: [{ token, symbol: 'PACT', verdict: 'CLEAN', market: 'ascend' }] }) + '\n'));
        setTimeout(() => { controller.enqueue(encoder.encode(JSON.stringify({ type: 'text', text: 'Fixture answer.' }) + '\n')); controller.close(); }, 3500);
      } }), { headers: { 'content-type': 'application/x-ndjson' } }));
    };
  }, { token });
  await page.goto('/delphi/chat');
  await ready(page);
  await page.evaluate(() => {
    const state = { overlap: false, sawThink: false, sawAnswer: false };
    Object.assign(window, { revealState: state });
    const sample = () => {
      const think = document.querySelector('[aria-busy] > div:first-child');
      const answer = document.querySelector('[aria-busy] > div:nth-child(2)');
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
  await expect(page.getByText('Opening PACT’s report…', { exact: true })).toBeVisible();
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
