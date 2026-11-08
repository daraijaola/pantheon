import { token } from './data.mjs';

const readAt = '2026-11-07T00:00:00Z';
const amount = value => ({ raw: '0', amount: value });

export const uploaded = {
  read: { read: null, refreshAfter: 0 },
  bag: {
    readAt, coins: [{ token, symbol: 'PACT', name: 'Fixture PACT', venue: 'ascend', amount: '1250', verdict: 'CLEAN', reason: 'Fixture checks passed.', reportUrl: `/delphi/${token}`, disputeUrl: null, scannedAt: readAt, stale: false }],
    counts: { CLEAN: 1 }, sentIn: [], wholeWallet: true, unread: [], complete: true, checking: false,
  },
  rewards: { readAt, coins: [], passportBoost: 1, unread: [], complete: true },
  stake: { readAt, staked: amount('100'), cooling: amount('0'), coolEnd: null, canWithdraw: false, stakeStart: readAt, timeBonus: { now: 1, max: 2, progress: 0, fullAt: null }, passportBoost: 1, passportTier: 0, multiplier: { earning: 1, ifRefreshed: 1 }, needsRefresh: false },
  standing: { readAt, firstSeen: { block: '100', time: readAt }, staking: { now: amount('100'), bonusSince: readAt, firstStaked: readAt }, roundsVoted: [], coinsLaunched: { total: 0, byVerdict: {} }, passport: { tier: 0, boost: 1 }, complete: true },
  guard: { readAt, alerts: [], coinsWatched: 1, watchingSince: readAt, unread: [], complete: true },
  record: { readAt, rounds: [], totals: { rounds: 0, picks: 0, seatsWon: 0 }, complete: true },
  ballot: { round: null, canVote: false, whyNot: 'NO_ROUND', votes: 0, maxPicks: 0, picks: [], closesAt: null },
};
