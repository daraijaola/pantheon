import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

test('offline proxy denies external HTTP and HTTPS without intercepting local requests', async ({ page, request }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  for (const protocol of ['http', 'https']) {
    const host = `${randomUUID()}.invalid`;
    expect(await page.evaluate(async url => {
      try { return !(await fetch(url)).ok; } catch { return true; }
    }, `${protocol}://${host}/blocked`)).toBe(true);
    await expect.poll(async () => {
      const response = await request.get('http://127.0.0.1:4174/__denied');
      return (await response.json() as string[]).some(url => url.includes(host));
    }).toBe(true);
  }
});
