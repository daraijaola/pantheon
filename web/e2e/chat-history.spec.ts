import { test, expect, ready } from './support';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.0.${info.workerIndex + 1}` });
});

test('New chat preserves signed answers in browser history; reload and reopen restore them', async ({ page }) => {
  await page.goto('/delphi/chat');
  await ready(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('No chats yet.', { exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Is PACT clean?', exact: true }).click();
  await expect(page.getByText('PACT passed the fixture checks.', { exact: false }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.reload();
  await ready(page);
  await expect(page.getByText('PACT passed the fixture checks.', { exact: false }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ask DELPHI about any coin.', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Is PACT clean/ }).click();
  await expect(page.getByText('PACT passed the fixture checks.', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'See all chats', exact: true }).click();
  await page.getByRole('button', { name: 'Delete chat: Is PACT clean?', exact: true }).click();
  await expect(page.getByText('No chats yet.', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.reload();
  await ready(page);
  await expect(page.getByRole('heading', { name: 'Ask DELPHI about any coin.', exact: true })).toBeVisible();
});

test('History shows ten recent chats and all chats includes deletion', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pantheon.delphi.chats.v1', JSON.stringify({ active: null, chats: Array.from({ length: 12 }, (_, i) => ({
    id: String(i), title: `Question ${i}`, updatedAt: Date.now() + i,
    turns: [{ id: 1, question: `Question ${i}`, text: `Answer ${i}`, coins: [], proofs: [], status: 'done' }],
  })) })));
  await page.goto('/delphi/chat');
  await ready(page);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('listitem')).toHaveCount(10);
  await expect(dialog.getByRole('listitem').first()).toContainText('Question 11');
  await expect(dialog.locator('time')).toHaveCount(10);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'History', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'See all chats', exact: true }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(12);
  await dialog.getByRole('button', { name: 'Delete chat: Question 0', exact: true }).click();
  await expect(dialog.getByRole('listitem')).toHaveCount(11);
  await dialog.getByRole('button', { name: /Question 11/ }).first().click();
  await expect(page.getByRole('list', { name: 'Conversation with DELPHI' }).getByText('Answer 11', { exact: true })).toBeVisible();
});

test('Unavailable local storage does not break chat', async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key: string) {
      if (key === 'pantheon.delphi.chats.v1') throw new Error('storage blocked');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key === 'pantheon.delphi.chats.v1') throw new Error('storage blocked');
      return set.call(this, key, value);
    };
  });
  await page.goto('/delphi/chat');
  await ready(page);
  await page.getByRole('button', { name: 'Is PACT clean?', exact: true }).click();
  await expect(page.getByText('PACT passed the fixture checks.', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('Chat history can’t be saved in this browser.', { exact: true })).toBeVisible();
});
