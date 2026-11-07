import { test, expect, connect, ready } from './support';

for (const route of ['/stake', '/get', '/trials/vote']) {
  test(`${route}: disconnected actions are gated`, async ({ page }) => {
    await page.goto(route);
    await ready(page);
    if (route === '/get') await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
    else await expect(page.getByRole('link', { name: 'Get uploaded', exact: true }).first()).toBeVisible();
    if (route === '/stake') await expect(page.getByRole('button', { name: 'Stake', exact: true })).toBeDisabled();
    if (route === '/trials/vote') await expect(page.getByRole('button', { name: 'Connect your wallet to vote', exact: true })).toBeDisabled();
  });

  test(`${route}: wrong chain prompts and can switch`, async ({ page }) => {
    await connect(page, '0x1');
    await page.goto(route);
    await ready(page);
    const change = page.getByRole('button', { name: /^Switch to Elysium/ }).first();
    await expect(change).toBeVisible();
    await change.click();
    await expect(page.getByRole('button', { name: /^Switch to Elysium/ })).toHaveCount(0);
  });

  test(`${route}: right chain, rejected approval/signature leaves usable page`, async ({ page }) => {
    test.fixme(route === '/stake', 'E2E F09: connected stake emits React hydration error 418');
    await connect(page);
    // Keep wallet state on client-side navigation, as the app's links do.
    await page.getByRole('link', { name: 'PANTHEON home' }).click();
    if (route === '/get') await page.locator('main a[href="/get"]').first().click();
    else if (route === '/stake') await page.locator('footer').getByRole('link', { name: 'Stake PNTH', exact: true }).click();
    else {
      await page.getByRole('button', { name: /^(Explore|Open menu)$/ }).click();
      await page.locator('nav[aria-label="Explore"] a[href="/trials"]').click();
      await page.getByRole('link', { name: 'Vote now', exact: true }).click();
    }
    await ready(page);
    if (route === '/stake') {
      await page.locator('input[inputmode="decimal"]').fill('1');
      const stake = page.getByRole('button', { name: 'Approve and stake', exact: true });
      await expect(stake).toBeEnabled();
      await stake.click();
      await expect(page.getByText('You cancelled it in your wallet.', { exact: true })).toBeVisible();
      await expect(stake).toBeEnabled();
      await page.getByRole('tab', { name: 'Unstake', exact: true }).click();
      await expect(page.getByRole('tab', { name: 'Unstake', exact: true })).toHaveAttribute('aria-selected', 'true');
    } else if (route === '/get') {
      const action = page.getByRole('button', { name: 'Get test PNTH', exact: true });
      await expect(action).toBeEnabled();
      await action.click();
      await expect(page.getByText('You cancelled it in your wallet.', { exact: true })).toBeVisible();
      await expect(action).toBeEnabled();
    } else {
      await page.getByRole('checkbox').first().check();
      const sign = page.getByRole('button', { name: 'Sign my vote (free)', exact: true });
      await sign.click();
      await expect(page.getByText('You cancelled it in your wallet.', { exact: true })).toBeVisible();
      await expect(sign).toBeEnabled();
      await page.getByRole('checkbox').first().uncheck();
    }
  });
}

test('/upload: connect, rejected signature, retry and disconnect', async ({ page }) => {
  await connect(page);
  const sign = page.getByRole('button', { name: 'Sign message', exact: true });
  await sign.click();
  await expect(page.getByRole('alert').filter({ hasText: 'You closed it in your wallet. Sign to go on.' })).toBeVisible();
  await expect(sign).toBeEnabled();
  await page.getByRole('button', { name: /another wallet|other wallet/i }).click();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
});
