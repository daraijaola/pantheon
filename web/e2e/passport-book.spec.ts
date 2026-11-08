import { test, expect, connect, ready } from './support';
import type { Page } from '@playwright/test';
import { wallet } from './fixtures/data.mjs';
import { expiredWallet, noPassportWallet, hiddenKey, passportRpc } from './fixtures/passport.mjs';

async function mockRegistry(page: Page, state: string | (() => string)) {
  await page.route('**/rpc', async route => {
    const data = route.request().postDataJSON();
    const read = (call: unknown) => passportRpc(call, typeof state === 'string' ? state : state());
    return route.fulfill({ json: Array.isArray(data) ? await Promise.all(data.map(read)) : await read(data) });
  });
}

async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const card = page.getByRole('img', { name: /HYPE Passport:/ });
  if (await card.count()) {
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expect(page.getByRole('button', { name: /KHYPE stamp,/ })).toHaveAttribute('aria-label', /10\+ HYPE worth of kHYPE/);
  }
}

async function capture(page: Page, name: string) {
  if (!process.env.PASSPORT_SCREENSHOTS || page.viewportSize()!.width === 360) return;
  const stamps = page.getByRole('region', { name: /^Stamps:/ });
  if (await stamps.count()) {
    await stamps.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(2300);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.screenshot({ path: `${process.env.PASSPORT_SCREENSHOTS}/${name}-${page.viewportSize()!.width === 1440 ? 'desktop' : 'mobile'}.png`, fullPage: true });
}

for (const state of ['valid', 'expired', 'none']) {
  test(`PassportBook: connected ${state} is truthful`, async ({ page }) => {
    await mockRegistry(page, state);
    await connect(page);
    await page.goto('/passport/me');
    await ready(page);
    if (state === 'none') {
      await expect(page.getByRole('heading', { name: 'No passport yet' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Get your Passport', exact: true })).toHaveAttribute('href', '/passport/get');
      await expect(page.getByRole('img', { name: /HYPE Passport:/ })).toHaveCount(0);
    } else {
      const facts = page.getByRole('definition');
      await expect(page.locator('dl[aria-label="Passport facts"]')).toContainText(state === 'valid' ? 'Valid' : 'Expired');
      await expect(facts.filter({ hasText: '3/8' })).toHaveCount(1);
      await expect(page.getByRole('img', { name: /HYPE Passport:/ })).toHaveAttribute('aria-label', new RegExp(state === 'valid' ? '1.20×, 2 extra' : '1.00×, 0 extra'));
      if (state === 'expired') await expect(page.getByRole('link', { name: 'Refresh passport' })).toHaveAttribute('href', '/passport/get');
    }
    await expect(page.getByText(/Example passport · preview only/)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(hiddenKey);
    await geometry(page);
    await capture(page, state);
  });
}

test('PassportBook: read error is distinct from no passport and retry recovers', async ({ page }) => {
  let state = 'error';
  await mockRegistry(page, () => state);
  await connect(page);
  await page.goto('/passport/me');
  await expect(page.getByRole('heading', { name: "Couldn't read your passport" })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No passport yet' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /HYPE Passport:/ })).toHaveCount(0);
  state = 'valid';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('dl[aria-label="Passport facts"]')).toContainText('Valid');
});

test('PassportBook: disconnected preview is clearly labelled and connect is local', async ({ page }) => {
  await page.goto('/passport/me');
  await ready(page);
  await expect(page.getByText('PANTHEON · Example passport · preview only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
  await expect(page.locator('dl[aria-label="Passport facts"]')).toHaveCount(0);
  await geometry(page);
});

test('PassportBook: wrong chain offers the existing switch, never a fake card', async ({ page }) => {
  await connect(page, '0x1');
  await page.goto('/passport/me');
  await expect(page.getByRole('heading', { name: 'Switch to Elysium', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /HYPE Passport:/ })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: 'Switch to Elysium', exact: true })).toBeVisible();
});

test('Public passport reads Elysium even when the viewer is connected to another chain', async ({ page }) => {
  await mockRegistry(page, 'valid');
  await connect(page, '0x1');
  await page.goto(`/passport/${wallet}`);
  await expect(page.locator('dl[aria-label="Passport facts"]')).toContainText('Valid');
});

for (const [state, address] of [['valid', wallet], ['expired', expiredWallet], ['none', noPassportWallet]]) {
  test(`Public passport: ${state}, without a connected wallet`, async ({ page }) => {
    await mockRegistry(page, state);
    const response = await page.goto(`/passport/${address}`);
    expect(response!.status()).toBe(200);
    await ready(page);
    if (state === 'none') await expect(page.getByRole('heading', { name: 'No passport yet' })).toBeVisible();
    else await expect(page.locator('dl[aria-label="Passport facts"]')).toContainText(state === 'valid' ? 'Valid' : 'Expired');
    await expect(page.getByText(/Example passport · preview only/)).toHaveCount(0);
    await geometry(page);
    if (state === 'valid') await capture(page, 'public');
    const og = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(og).toContain(`/passport/${address.toLowerCase()}/opengraph-image`);
  });
}

test('Passport share fallback copies only the public link and offers X', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }));
  await mockRegistry(page, 'valid');
  await connect(page);
  await page.goto('/passport/me');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Link copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:4173/passport/${wallet.toLowerCase()}`);
  const x = new URL((await page.getByRole('link', { name: 'Share on X', exact: true }).getAttribute('href'))!);
  expect(x.searchParams.get('text')).toContain('Tier 2, 1.20x boost');
  expect(x.searchParams.get('url')).toBe(`http://127.0.0.1:4173/passport/${wallet.toLowerCase()}`);
});

test('Public passport native share uses public facts only', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => { document.documentElement.dataset.shared = JSON.stringify(data); }, configurable: true }));
  await mockRegistry(page, 'valid');
  await page.goto(`/passport/${wallet}`);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const data = JSON.parse((await page.locator('html').getAttribute('data-shared'))!);
  expect(data.url).toBe(`http://127.0.0.1:4173/passport/${wallet.toLowerCase()}`);
  expect(data.text).toContain('Tier 2, 1.20x boost');
  expect(JSON.stringify(data)).not.toContain(hiddenKey);
});

test('Per-wallet OG renders PNG for valid, expired and empty records', async ({ page, request }) => {
  for (const address of [wallet, expiredWallet, noPassportWallet]) {
    await page.goto(`/passport/${address}`);
    const image = new URL((await page.locator('meta[property="og:image"]').getAttribute('content'))!);
    const response = await request.get(image.pathname + image.search);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
    expect((await response.body()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }
});
