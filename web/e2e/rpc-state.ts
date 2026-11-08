import type { Page } from '@playwright/test';
import { rpc } from './fixtures/rpc.mjs';

export async function mockRpc(page: Page, overrides: Record<string, unknown>) {
  await page.route('**/rpc', async route => {
    const request = route.request().postDataJSON();
    const result = Array.isArray(request) ? await Promise.all(request.map(item => rpc(item, overrides))) : await rpc(request, overrides);
    await route.fulfill({ json: result });
  });
}
