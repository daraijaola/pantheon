export const token = '0x4FAA6142168c6A1126df68CF400839126b3664db';
export const wallet = '0x0000000000000000000000000000000000000042';
export const timestamp = 1794000000;
const counts = { coins: 1, CLEAN: 1, FLAG: 0, WATCH: 0, NOT_ENOUGH_DATA: 0 };
const coin = { token, symbol: 'PACT', name: 'Fixture PACT', verdict: 'CLEAN', trades: 100, wallets: 25, holders: 20, launched: '2026-11-01T00:00:00Z', people: { wallets: 25, people: 23 } };
export const site = {
  generatedAt: '2026-11-07T00:00:00Z', scannedAt: '2026-11-07T00:00:00Z', explorer: 'https://explorer.invalid',
  rules: { version: 'e2e', bundle: { windowSec: 60, watchPct: 10, flagPct: 20 }, wash: { pairWindowSec: 60, watchPct: 10, flagPct: 20, minTrades: 10 }, concentration: { watchPct: 30, flagPct: 50, minHolders: 10 } },
  counts, coins: [coin], kalos: { counts: { ...counts, coins: 0, CLEAN: 0 }, coins: [] },
  explained: { [token.toLowerCase()]: {
    report: { rules: 'e2e', generatedAt: '2026-11-07T00:00:00Z', coin: { token, symbol: 'PACT', name: 'Fixture PACT', creator: wallet, launchTx: `0x${'1'.repeat(64)}`, launchTime: '2026-11-01T00:00:00Z', url: 'https://explorer.invalid/token', launchUrl: 'https://explorer.invalid/tx' }, stats: { trades: 100, outsideTrades: 98, traders: 25, holders: 20, links: 0, fundingMissing: 0 }, verdict: 'CLEAN', notes: [], checks: { bundle: 'clear', wash: 'clear', concentration: 'clear' }, findings: [] },
    explanation: { verdict: 'CLEAN', headline: 'PACT passed the fixture checks.', summary: 'No linked-wallet bundle or wash trading was found in this deterministic test dataset.', points: [{ text: 'The checks used 100 trades and 20 holders.', evidence: [] }], caveats: ['A clean verdict is not a promise of safety.'] }, model: 'fixture', writtenAt: '2026-11-07T00:00:00Z',
  } },
};
const amount = { raw: '100000000000000000000', value: '100', symbol: 'PNTH', token };
export const stats = { ok: true, lastBlock: '10000000', linked: 2, valid: 2, updatedAt: timestamp, pnth: { burned: amount, lastBurn: null }, basket: { spent: { ...amount, symbol: 'USDC' }, buys: 3, lastBuy: null }, staking: { stakers: 2 } };
export const basket = { active: { id: 1, status: 'active', startsAt: timestamp, coins: [{ token, symbol: 'PACT', weightPct: 100, bought: amount, buys: 3 }] }, proposals: [] };
export function trials(voter) {
  return { round: 1, status: 'open', opensAt: 1, closesAt: 4102444800, seats: 1, candidates: [{ token, symbol: 'PACT', verdict: 'CLEAN', headline: 'PACT passed the fixture checks.', realUsdc: '100000000', rank: 1, votes: 2, voters: 2 }], leaders: [token], ballots: 2, ...(voter ? { you: { voter, weight: 1, tier: 0, ballot: null } } : {}) };
}
