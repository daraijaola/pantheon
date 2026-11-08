import { test, expect, ready } from './support';
import { trials, token, wallet } from './fixtures/data.mjs';

const closed = { ...trials(), round: 5, status: 'closed', opensAt: 1794000000, closesAt: 1794086400 };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/trials/current*', route => route.fulfill({ json: closed }));
});

test('Closed Trials leads with results and readable ballots, never selection controls', async ({ page }) => {
  await page.route('**/api/trials/rounds/5', route => route.fulfill({ json: { ...closed, ballotList: [{ voter: wallet, coins: [token], weight: 2, signedAt: 1794000001 }] } }));
  await page.goto('/trials/vote');
  await ready(page);
  await expect(page.getByRole('heading', { name: 'Round 5 results' })).toBeVisible();
  await expect(page.getByText('Next round opens soon', { exact: true })).toBeVisible();
  await expect(page.getByText(/Opened .* UTC. Closed .* UTC/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Round winners' })).toContainText('1. PACT');
  await expect(page.getByRole('region', { name: 'Public ballots' })).toContainText('Weight 2');
  await expect(page.getByRole('region', { name: 'Public ballots' })).toContainText('0x0000…0042');
  await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
  await expect(page.getByText(/of \d+ picked|Leading now|so far/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Connect|vote|Pick/ })).toHaveCount(0);
  const disclosure = page.locator('details').filter({ has: page.getByText('Candidates and final tally (1)', { exact: true }) });
  await expect(disclosure).not.toHaveAttribute('open');
  await disclosure.locator('summary').click();
  await expect(disclosure.getByRole('link', { name: 'PACT' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'raw data' })).toHaveAttribute('href', '/api/trials/rounds/5');
});

test('Closed Trials has honest empty results and ballots', async ({ page }) => {
  await page.route('**/api/trials/current*', route => route.fulfill({ json: { ...closed, leaders: [], candidates: [], ballots: 0, nextOpensAt: 1794172800 } }));
  await page.route('**/api/trials/rounds/5', route => route.fulfill({ json: { ballotList: [] } }));
  await page.goto('/trials/vote');
  await expect(page.getByText('No winners in this round.')).toBeVisible();
  await expect(page.getByText('No ballots in this round.')).toBeVisible();
  await expect(page.getByText(/^Next round opens .* UTC$/)).toBeVisible();
});

test('Unreadable ballots do not hide the results or pretend to be empty', async ({ page }) => {
  await page.route('**/api/trials/rounds/5', route => route.fulfill({ json: { error: 'UNAVAILABLE' } }));
  await page.goto('/trials/vote');
  await expect(page.getByText('Ballots couldn’t be read just now. Try again in a minute.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('heading', { name: 'Round 5 results' })).toBeVisible();
});

test('Upcoming state takes priority over connecting', async ({ page }) => {
  await page.route('**/api/trials/current*', route => route.fulfill({ json: { ...closed, status: 'upcoming' } }));
  await page.goto('/trials/vote');
  await expect(page.getByRole('button', { name: 'The vote hasn’t opened yet' })).toBeDisabled();
});
