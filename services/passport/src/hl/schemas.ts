// zod schemas for the HL info responses we use (spec §2). Permissive: unknown fields pass through,
// only the fields scoring needs are checked. Amounts stay decimal strings; score.ts converts them.
import { z } from "zod";

export const decimal = z.string().regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");
const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an address");

/** §2.1. Roles are not an enum here: policy accepts only "user"/"missing", so a new role fails closed. */
export const UserRole = z.looseObject({
  role: z.string(),
  data: z.looseObject({ user: hexAddress.optional(), master: hexAddress.optional() }).optional(),
});

/** §2.2 (tests and support only). `validUntil` is null for an agent without expiry (nktkas/hyperliquid SDK types). */
export const ExtraAgents = z.array(z.looseObject({ name: z.string(), address: hexAddress, validUntil: z.number().nullable() }));

const SpotBalance = z.looseObject({ coin: z.string(), token: z.number().int(), total: decimal, hold: decimal });

/** §2.3. `total` includes HYPE supplied to lending. */
export const SpotClearinghouseState = z.looseObject({ balances: z.array(SpotBalance) });

const Amount = z.looseObject({ basis: decimal, value: decimal });

/** §2.4. `tokenToState` is a list of [token, state] pairs. */
export const BorrowLendUserState = z.looseObject({
  tokenToState: z.array(z.tuple([z.number().int(), z.looseObject({ borrow: Amount, supply: Amount })])),
});

/** §2.5. */
export const DelegatorSummary = z.looseObject({
  delegated: decimal,
  undelegated: decimal,
  totalPendingWithdrawal: decimal,
  nPendingWithdrawals: z.number().int(),
});

/** §2.6. Oldest first, at most 2000 per call (checked live 2026-10-11). */
export const LedgerUpdates = z.array(
  z.looseObject({ time: z.number().int(), hash: z.string(), delta: z.looseObject({ type: z.string() }) }),
);

/** §2.7. A list of [period, stats] pairs; only `vlm` is needed. */
export const Portfolio = z.array(z.tuple([z.string(), z.looseObject({ vlm: decimal })]));

/** §2.8. The API returns null (not []) when there are no sub-accounts. */
export const SubAccounts = z
  .array(
    z.looseObject({
      name: z.string(),
      subAccountUser: hexAddress,
      master: hexAddress,
      spotState: z.looseObject({ balances: z.array(SpotBalance) }),
    }),
  )
  .nullable()
  .transform((v) => v ?? []);

/**
 * §2.10. null for a normal user (live). The multi-sig shape comes from the nktkas/hyperliquid SDK
 * types, not from a live multi-sig account. v1 rejects any non-null result (MULTISIG_UNSUPPORTED).
 */
export const MultiSigSigners = z
  .looseObject({ authorizedUsers: z.array(hexAddress), threshold: z.number().int() })
  .nullable();

/** §2.9. Not used for tiers. */
export const ClearinghouseState = z.looseObject({
  marginSummary: z.looseObject({ accountValue: decimal }),
  time: z.number().int(),
});

export type UserRole = z.infer<typeof UserRole>;
export type ExtraAgents = z.infer<typeof ExtraAgents>;
export type SpotClearinghouseState = z.infer<typeof SpotClearinghouseState>;
export type BorrowLendUserState = z.infer<typeof BorrowLendUserState>;
export type DelegatorSummary = z.infer<typeof DelegatorSummary>;
export type LedgerUpdates = z.infer<typeof LedgerUpdates>;
export type Portfolio = z.infer<typeof Portfolio>;
export type SubAccounts = z.output<typeof SubAccounts>;
export type MultiSigSigners = z.infer<typeof MultiSigSigners>;
export type ClearinghouseState = z.infer<typeof ClearinghouseState>;
