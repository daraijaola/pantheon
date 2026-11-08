import { createHmac } from 'node:crypto';
import { test, expect, ready } from './support';
import { wallet } from './fixtures/data.mjs';

const origin = 'https://127.0.0.1:4176';
function session(expires = Date.now() + 60_000, boundOrigin = origin) {
  const payload = Buffer.from(JSON.stringify({ wallet, origin: boundOrigin, expires })).toString('base64url');
  const mac = createHmac('sha256', 'e2e-only-session-secret-not-for-deployment').update(`session.${payload}`).digest('base64url');
  return `${payload}.${mac}`;
}

test('Homepage redirects only a signed, live, origin-bound session and allows the escape hatch', async ({ request }) => {
  const cookie = session();
  const redirect = await request.get(`${origin}/`, { headers: { cookie: `pantheon_session=${cookie}` }, maxRedirects: 0 });
  expect(redirect.status()).toBe(307);
  expect(new URL(redirect.headers().location, origin).href).toBe(`${origin}/space`);
  expect(redirect.headers()['cache-control']).toContain('no-store');
  const bypass = await request.get(`${origin}/?home=1`, { headers: { cookie: `pantheon_session=${cookie}` }, maxRedirects: 0 });
  expect(bypass.status()).toBe(200);
  for (const value of ['', 'invalid', `x${cookie}`, session(Date.now() - 1000), session(Date.now() + 60_000, 'https://other.example')]) {
    const response = await request.get(`${origin}/`, { headers: { cookie: `pantheon_session=${value}` }, maxRedirects: 0 });
    expect(response.status()).toBe(200);
  }
  const crawler = await request.get(`${origin}/`, { headers: { 'user-agent': 'Googlebot' }, maxRedirects: 0 });
  expect(crawler.status()).toBe(200);
});

test('Signed-in homepage opens Space, the app home link bypasses it, and logout restores the landing page', async ({ page, context }) => {
  await context.addCookies([{ name: 'pantheon_session', value: session(), url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  await page.goto(`${origin}/`);
  await ready(page);
  await expect(page).toHaveURL(`${origin}/space`);
  await expect(page.getByRole('heading', { name: 'Your space', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'PANTHEON, back to the site', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/?home=1`);
  expect((await page.request.get(`${origin}/api/auth/me`)).status()).toBe(200);
  const logout = await page.request.post(`${origin}/api/auth/logout`, { headers: { origin } });
  expect(logout.status()).toBe(200);
  const landing = await page.goto(`${origin}/`);
  expect(landing?.status()).toBe(200);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByRole('heading', { name: 'Your space', exact: true })).toHaveCount(0);
});

test('Passport tiers and FAQ show five counted HYPE while higher tiers stay unchanged', async ({ page }) => {
  await page.goto('/passport');
  await ready(page);
  await expect(page.getByRole('row', { name: /Tier 1.*5 HYPE/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Tier 2.*100 HYPE.*30 days/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Tier 3.*1,000 HYPE.*90 days/ })).toBeVisible();
  await page.getByText('What do I need for Tier 1?', { exact: true }).click();
  await expect(page.getByText(/5 HYPE counted: 5 staked HYPE or 10 unstaked HYPE/)).toBeVisible();
  await page.goto('/passport/get');
  await expect(page.getByRole('listitem').filter({ hasText: 'Tier 1' })).toContainText('5 HYPE');
});
