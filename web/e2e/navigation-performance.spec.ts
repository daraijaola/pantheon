import { test, expect, ready, connect } from './support';
import { wallet } from './fixtures/data.mjs';
import { uploaded } from './fixtures/uploaded.mjs';

for (const saved of [false, true]) test(`Get uploaded opens immediately while session is pending; saved read=${saved}`, async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/me', async route => { await pending; await route.fulfill({ json: { wallet } }); });
  await page.route('**/api/me/**', route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1) as keyof typeof uploaded;
    return route.fulfill({ json: key === 'read' ? { read: saved ? { wallet, readAt: Date.now(), stages: [] } : null, refreshAfter: Date.now() + 600_000 } : uploaded[key] });
  });
  try {
    await page.goto('/');
    await ready(page);
    await page.locator('main').getByRole('button', { name: /^Get uploaded/ }).first().click();
    await expect(page).toHaveURL('http://127.0.0.1:4173/upload');
    await expect(page.getByRole('heading', { name: 'Get uploaded.', exact: true })).toBeVisible();
  } finally { release(); }
  if (saved) {
    await expect(page).toHaveURL('http://127.0.0.1:4173/space');
    await expect(page.getByRole('heading', { name: 'Your space', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue \(bubble/ })).toHaveCount(0);
  }
});

test('Space orb, Stake, Trials, Passport and return use client navigation', async ({ page }) => {
  await connect(page);
  await page.route('**/api/auth/me', route => route.fulfill({ json: { wallet } }));
  await page.route('**/api/me/**', route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1) as keyof typeof uploaded;
    return route.fulfill({ json: key === 'read' ? { read: { wallet, readAt: Date.now(), stages: [] }, refreshAfter: Date.now() + 600_000 } : uploaded[key] });
  });
  await page.goto('/space');
  await ready(page);
  const documents: string[] = [];
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url()); });
  const links = ['/delphi/chat', '/space', '/stake', '/space', '/trials/vote', '/space', '/passport/me', '/space'];
  for (const href of links) {
    if (href === '/passport/me') await page.getByRole('button', { name: /^Your wallet/ }).click();
    const link = href === '/delphi/chat' && page.viewportSize()!.width > 760
      ? page.getByRole('link', { name: 'Ask DELPHI', exact: true })
      : page.locator(`a[href="${href}"]:visible`).first();
    await link.click();
    await expect(page).toHaveURL(`http://127.0.0.1:4173${href}`);
    await expect(page.locator('[data-route-loading]')).toHaveCount(0);
    await expect(page.locator('h1').first()).toBeVisible();
  }
  expect(documents).toEqual([]);
});
