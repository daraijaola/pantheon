import { rpc } from './rpc.mjs';

export const expiredWallet = `0x${'33'.repeat(20)}`;
export const noPassportWallet = `0x${'22'.repeat(20)}`;
export const hiddenKey = `0x${'aa'.repeat(32)}`;

export async function passportRpc(request, state) {
  const data = request.params?.[0]?.data?.toLowerCase() ?? '';
  state ??= data.includes(noPassportWallet.slice(2)) ? 'none' : data.includes(expiredWallet.slice(2)) ? 'expired' : 'valid';
  if (state === 'error') return { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Registry temporarily unavailable' } };
  const now = BigInt(Math.floor(Date.now() / 1000));
  return rpc(request, {
    passportOf: { hlKey: state === 'none' ? `0x${'00'.repeat(32)}` : hiddenKey, tier: state === 'none' ? 0 : 2, stamps: state === 'none' ? 0 : 131, issuedAt: state === 'none' ? 0n : now - 86400n * 7n, expiry: state === 'none' ? 0n : state === 'expired' ? now - 86400n : now + 86400n * 7n, linkedAt: state === 'none' ? 0n : now - 86400n * 90n },
    isValid: state === 'valid', multiplierOf: state === 'valid' ? 1200000000000000000n : 1000000000000000000n,
  });
}
