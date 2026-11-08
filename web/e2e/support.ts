import { test as base, expect, type Page } from '@playwright/test';
import { wallet } from './fixtures/data.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export const test = base.extend<{ browserGuards: void }>({
  browserGuards: [async ({ context, page, browserName, request }, use) => {
    const errors: string[] = [];
    const external: string[] = [];
    const watch = (target: Page) => {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => {
      if (message.type() !== 'error') return;
      if (browserName === 'webkit' && message.text() === 'Viewport argument key "interactive-widget" not recognized and ignored.') return;
      errors.push(message.text());
    });
    };
    watch(page);
    context.on('page', watch);
    context.on('request', request => {
      const url = new URL(request.url());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'http://127.0.0.1:4173' && url.origin !== 'http://127.0.0.1:4174' && url.origin !== 'https://127.0.0.1:4176') external.push(url.href);
    });
    await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
    await use();
    expect(external, 'Unexpected outbound browser requests (suite must run offline)').toEqual([]);
    expect(errors, 'Uncaught page/console errors').toEqual([]);
    const fixtureErrors = await request.get('http://127.0.0.1:4174/__unexpected');
    expect(await fixtureErrors.json(), 'Unconfigured local service/RPC fixtures').toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function ready(page: Page) {
  await page.waitForLoadState('load');
  await page.evaluate(async () => { await document.fonts.ready; });
  await expect(page.locator('body')).not.toBeEmpty();
  // Fast-forward finite entry effects; paused Firefox animations never resolve `finished`.
  await page.evaluate(async () => {
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
        try { animation.finish(); } catch { /* An idle effect has nothing to finish. */ }
      }
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

export async function installWallet(page: Page, chain = '0x185d9', acceptSignatures = false) {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  if (acceptSignatures) await page.exposeFunction('e2eSignMessage', (message: Hex) => account.signMessage({ message: { raw: message } }));
  await page.addInitScript(({ address, initialChain }) => {
    let currentChain = initialChain;
    let connected = false;
    const listeners: Record<string, Array<(value: unknown) => void>> = {};
    const emit = (event: string, value: unknown) => listeners[event]?.forEach(fn => fn(value));
    const ethereum = {
      isMetaMask: true,
      isConnected: () => connected,
      on: (event: string, fn: (value: unknown) => void) => { (listeners[event] ??= []).push(fn); },
      removeListener: (event: string, fn: (value: unknown) => void) => { listeners[event] = (listeners[event] ?? []).filter(x => x !== fn); },
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_requestAccounts') { connected = true; emit('accountsChanged', [address]); return [address]; }
        if (method === 'eth_accounts') return connected || localStorage.getItem('e2e-wallet') ? [address] : [];
        if (method === 'eth_chainId') return currentChain;
        if (method === 'net_version') return String(parseInt(currentChain, 16));
        if (method === 'wallet_getPermissions' || method === 'wallet_requestPermissions') { localStorage.setItem('e2e-wallet', 'connected'); return [{ parentCapability: 'eth_accounts' }]; }
        if (method === 'wallet_switchEthereumChain') { currentChain = (params![0] as { chainId: string }).chainId; emit('chainChanged', currentChain); return null; }
        if (method === 'personal_sign' && 'e2eSignMessage' in window) return (window as unknown as { e2eSignMessage: (message: unknown) => Promise<string> }).e2eSignMessage(params![0]);
        if (method === 'personal_sign' || method.startsWith('eth_signTypedData') || method === 'eth_sendTransaction') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        throw Object.assign(new Error(`Unsupported mock wallet method: ${method}`), { code: 4200 });
      },
    };
    Object.defineProperty(window, 'ethereum', { value: ethereum, configurable: true });
    window.dispatchEvent(new Event('ethereum#initialized'));
  }, { address: acceptSignatures ? account.address : wallet, initialChain: chain });
}

export async function connect(page: Page, chain?: string, acceptSignatures = false, origin = '') {
  await installWallet(page, chain, acceptSignatures);
  await page.goto(`${origin}/upload`);
  await ready(page);
  const button = page.getByRole('button', { name: 'Connect wallet', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: 'Sign message', exact: true })).toBeVisible();
  // Persist authorization as a wallet would, so full-page navigation can reconnect.
  await page.evaluate(() => localStorage.setItem('e2e-wallet', 'connected'));
}
