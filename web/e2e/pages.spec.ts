import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test, expect, ready } from './support';
import { token } from './fixtures/data.mjs';

function routes(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return routes(path.join(dir, entry.name), entry.name.startsWith('(') ? prefix : `${prefix}/${entry.name}`);
    return entry.name === 'page.tsx' ? [prefix.replace('[token]', token) || '/'] : [];
  });
}

for (const route of routes(path.resolve(__dirname, '../src/app'))) {
  test(`page ${route}: status, resources, errors and layout`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await ready(page);
    await expect.poll(() => page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const header = document.querySelector('body header, a[aria-label="PANTHEON home"]')?.getBoundingClientRect();
      const hidden = (e: Element) => e.closest('[aria-hidden="true"]') || getComputedStyle(e).visibility === 'hidden';
      const overlap = header ? [...document.querySelectorAll('main h1, main h2, main p, button, input, textarea, [role="status"]')].filter(e => {
        const r = e.getBoundingClientRect();
        return !hidden(e) && r.width > 2 && r.height > 2 && r.bottom > header.top && r.top < header.bottom - 1 && !e.closest('header');
      }).map(e => `${e.tagName}: ${e.textContent?.slice(0, 80)}`) : [];
      return { width: root.clientWidth, scrollWidth: root.scrollWidth, overlap };
    });
    expect(layout.scrollWidth, 'Horizontal overflow').toBeLessThanOrEqual(layout.width);
    expect(layout.overlap, 'Visible content overlaps the global header').toEqual([]);
  });
}
