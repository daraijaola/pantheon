// The "powers" a token's controller may hold over its holders, by function signature: minting, taking
// or burning other people's tokens, blacklists, pausing, fees and taxes, trade limits, switching trading
// on and off, fee exemptions, pulling funds out, swapping the router or pair, and upgrading the code.
// Each signature's 4-byte selector is computed here (viem's toFunctionSelector), never looked up in a
// public signature database: those are full of junk collisions (Kalos's router "has"
// transfer_attention_tg_invmru_ec11fa8(uint256,bool), say).
import { toFunctionSelector, type Hex } from "viem";

export type PowerId =
  | "mint"
  | "take"
  | "blacklist"
  | "pause"
  | "fees"
  | "limits"
  | "trading"
  | "exempt"
  | "rescue"
  | "router"
  | "upgrade"
  | "bridge"
  | "ownership";

export type PowerKind = {
  id: PowerId;
  /** What it lets the controller do, in plain words (completes "The controller can …"). */
  does: string;
  /** Normal for a token and not a risk by itself (handing over ownership; a bridge's mint and burn). */
  normal?: true;
  /** Function names that mean this power in a verified ABI, whatever their arguments. */
  names?: RegExp;
  signatures: readonly string[];
};

/**
 * Signatures seen in common token templates (OpenZeppelin, Circle's FiatToken, the "SafeMoon",
 * "tax token" and "anti-bot" launch templates), checked by hand. `withdraw(uint256)` and `burnFrom`
 * are left out on purpose: the first is WHYPE's normal unwrap and the second spends an allowance the
 * holder gave.
 */
export const POWER_KINDS: readonly PowerKind[] = [
  {
    id: "mint",
    does: "create new tokens or set balances",
    names: /^(mint\w*|issue|ownerMint|adminMint|increaseSupply|setBalance\w*)$/i,
    signatures: [
      "mint(address,uint256)",
      "mint(uint256)",
      "mint(address,uint256,bytes)",
      "mintTo(address,uint256)",
      "mintFor(address,uint256)",
      "ownerMint(address,uint256)",
      "adminMint(address,uint256)",
      "issue(uint256)",
      "issue(address,uint256)",
      "increaseSupply(uint256)",
      "setBalance(address,uint256)",
    ],
  },
  {
    id: "take",
    does: "burn or move tokens out of other people's wallets",
    names: /^(adminBurn|burnFor|forceTransfer|adminTransfer|seize|confiscate|wipe\w*|destroyBlackFunds)$/i,
    signatures: [
      "burn(address,uint256)",
      "burnFor(address,uint256)",
      "adminBurn(address,uint256)",
      "forceTransfer(address,address,uint256)",
      "adminTransfer(address,address,uint256)",
      "seize(address,uint256)",
      "confiscate(address,uint256)",
      "wipe(address)",
      "destroyBlackFunds(address)",
    ],
  },
  {
    id: "blacklist",
    does: "block chosen wallets from trading (blacklist, blocklist or bot list)",
    names: /(black|block|deny)list|^(set|add|remove|mark)?bots?\b|^setBot|^addBot|^blockBots?|^freeze(Account)?$|^setSniper/i,
    signatures: [
      "blacklist(address)",
      "unBlacklist(address)",
      "addToBlacklist(address)",
      "addBlacklist(address)",
      "setBlacklist(address,bool)",
      "setBlacklisted(address,bool)",
      "setIsBlacklisted(address,bool)",
      "blacklistAddress(address,bool)",
      "updateBlacklist(address,bool)",
      "setBlacklistStatus(address,bool)",
      "manyBlacklist(address[])",
      "addToBlocklist(address)",
      "setBlocklist(address,bool)",
      "blockAddress(address)",
      "setBot(address,bool)",
      "setBots(address[],bool)",
      "addBot(address)",
      "addBots(address[])",
      "blockBots(address[])",
      "setSniper(address,bool)",
      "freeze(address)",
      "freezeAccount(address,bool)",
    ],
  },
  {
    id: "pause",
    does: "pause all transfers",
    names: /^(pause|setPaused|pauseTransfers)$/i,
    signatures: ["pause()", "setPaused(bool)", "pauseTransfers()"],
  },
  {
    id: "fees",
    does: "set or raise the buy, sell or transfer tax",
    // setFeeRecipient, setTaxWallet and the like only say where fees go: not matched.
    names: /^(set|update|change)\w*(fee|tax)(es|s)?(percent|rate|rates|bps|pips|amount)?$/i,
    signatures: [
      "setFee(uint256)",
      "setFee(uint256,uint256)",
      "setFees(uint256,uint256)",
      "setFees(uint256,uint256,uint256)",
      "setTax(uint256)",
      "setTax(uint256,uint256)",
      "setTaxes(uint256,uint256)",
      "setTaxes(uint256,uint256,uint256)",
      "setBuyFee(uint256)",
      "setSellFee(uint256)",
      "setBuyTax(uint256)",
      "setSellTax(uint256)",
      "setBuyFees(uint256,uint256,uint256)",
      "setSellFees(uint256,uint256,uint256)",
      "updateBuyFees(uint256,uint256,uint256)",
      "updateSellFees(uint256,uint256,uint256)",
      "updateFees(uint256,uint256)",
      "updateFees(uint256,uint256,uint256)",
      "setTaxFeePercent(uint256)",
      "setLiquidityFeePercent(uint256)",
      "setTransferFee(uint256)",
      "setFeeRate(uint256)",
      "setFeePercent(uint256)",
      "setTaxRate(uint256)",
      "setTaxPercent(uint256)",
      "setTaxPips(uint256)",
      "setTaxPips(uint24)",
    ],
  },
  {
    id: "limits",
    does: "change the most a wallet may buy, sell or hold",
    names: /^(set|update)\w*max\w*$|^removeLimits$|^setLimits$|^set\w*Limit\w*$/i,
    signatures: [
      "setMaxTxAmount(uint256)",
      "setMaxTx(uint256)",
      "setMaxTxPercent(uint256)",
      "setMaxTransactionAmount(uint256)",
      "updateMaxTxnAmount(uint256)",
      "setMaxWallet(uint256)",
      "setMaxWalletSize(uint256)",
      "setMaxWalletAmount(uint256)",
      "setMaxWalletPercent(uint256)",
      "updateMaxWalletAmount(uint256)",
      "setMaxBuyPerWallet(uint256)",
      "setLimits(uint256,uint256)",
      "removeLimits()",
    ],
  },
  {
    id: "trading",
    does: "switch trading on or off",
    names: /^(enable|disable|open|start|pause|stop)Trading$|^setTrading\w*$|^tradingStatus$/i,
    signatures: [
      "enableTrading()",
      "disableTrading()",
      "openTrading()",
      "startTrading()",
      "pauseTrading()",
      "setTradingEnabled(bool)",
      "setTrading(bool)",
      "setTradingOpen(bool)",
      "tradingStatus(bool)",
      "enableTrading(uint256)",
    ],
  },
  {
    id: "exempt",
    does: "let chosen wallets skip the tax or the limits",
    // Only fee, tax and limit exemptions: setRewardExempt and the like only opt a wallet out of rewards.
    names: /^(exclude|include)(From|In)(Fees?|Tax\w*|MaxTx\w*|MaxWallet\w*|Limits?)$|^set\w*(Fee|Tax|Limit|MaxTx|MaxWallet)\w*Exempt$|^set(Is)?Excluded?From(Fees?|Tax\w*)$|^setWhitelist\w*$/i,
    signatures: [
      "excludeFromFee(address)",
      "excludeFromFees(address,bool)",
      "includeInFee(address)",
      "setExcludeFromFee(address,bool)",
      "setExcludedFromFee(address,bool)",
      "setIsFeeExempt(address,bool)",
      "setFeeExempt(address,bool)",
      "excludeMultipleAccountsFromFees(address[],bool)",
      "excludeFromMaxTransaction(address,bool)",
      "setIsTxLimitExempt(address,bool)",
      "setWhitelist(address,bool)",
    ],
  },
  {
    id: "rescue",
    does: "pull tokens or HYPE out of the token contract",
    names: /^(rescue|recover|sweep|clearStuck|withdrawStuck|manualSend)\w*$|^withdraw(ETH|Eth|Native|Tokens?|ERC20)$/,
    signatures: [
      "rescueTokens(address,uint256)",
      "rescueToken(address,uint256)",
      "rescueERC20(address,uint256)",
      "recoverERC20(address,uint256)",
      "withdrawToken(address,uint256)",
      "withdrawTokens(address,uint256)",
      "withdrawStuckTokens(address)",
      "clearStuckBalance()",
      "clearStuckBalance(uint256)",
      "rescueETH()",
      "rescueETH(uint256)",
      "recoverETH()",
      "withdraw()",
      "withdrawETH()",
      "manualSend()",
    ],
  },
  {
    id: "router",
    does: "point the token at a different router or trading pair",
    names: /^(set|update)\w*(Router|Pair|AMM)\w*$/i,
    signatures: [
      "setRouter(address)",
      "setRouterAddress(address)",
      "updateRouter(address)",
      "updateUniswapV2Router(address)",
      "setUniswapRouter(address)",
      "setSwapRouter(address)",
      "setPair(address)",
      "setPairAddress(address)",
      "setUniswapPair(address)",
      "setAutomatedMarketMakerPair(address,bool)",
      "setAMMPair(address,bool)",
      "setMarketPair(address,bool)",
    ],
  },
  {
    id: "upgrade",
    does: "replace the token's code",
    names: /^(upgradeTo|upgradeToAndCall|diamondCut)$/,
    signatures: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)", "diamondCut((address,uint8,bytes4[])[],address,bytes)"],
  },
  {
    id: "bridge",
    does: "mint and burn as the token bridge (normal for a bridged token)",
    normal: true,
    names: /^bridge(Mint|Burn)$/,
    signatures: ["bridgeMint(address,uint256)", "bridgeBurn(address,uint256)"],
  },
  {
    id: "ownership",
    does: "hand over or give up control (normal)",
    normal: true,
    names: /^(transferOwnership|renounceOwnership|acceptOwnership|setOwner|grantRole|revokeRole|renounceRole)$/,
    signatures: ["transferOwnership(address)", "renounceOwnership()", "acceptOwnership()", "setOwner(address)", "grantRole(bytes32,address)"],
  },
];

/**
 * Functions a name pattern would catch in a verified ABI but that are normal: an ERC-4626 vault's
 * mint and withdraw, WHYPE's unwrap, burning your own tokens or an allowance you gave.
 */
export const NOT_POWERS: ReadonlySet<string> = new Set([
  "mint(uint256,address)",
  "withdraw(uint256,address,address)",
  "withdraw(uint256)",
  "withdrawTo(address,uint256)",
  "burn(uint256)",
  "burnFrom(address,uint256)",
]);

export type PowerSignature = { power: PowerId; signature: string; selector: Hex };

/** selector → the power and signature it stands for. */
export const POWER_SELECTORS: ReadonlyMap<Hex, PowerSignature> = new Map(
  POWER_KINDS.flatMap((k) => k.signatures.map((signature): [Hex, PowerSignature] => {
    const selector = toFunctionSelector(signature);
    return [selector, { power: k.id, signature, selector }];
  })),
);

export const powerKind = (id: PowerId): PowerKind => POWER_KINDS.find((k) => k.id === id)!;

/** Standard ERC-20 and ERC-2612 functions: not powers, and not "unknown" either. */
export const STANDARD_SELECTORS: ReadonlySet<Hex> = new Set(
  [
    "name()",
    "symbol()",
    "decimals()",
    "totalSupply()",
    "balanceOf(address)",
    "transfer(address,uint256)",
    "transferFrom(address,address,uint256)",
    "approve(address,uint256)",
    "allowance(address,address)",
    "increaseAllowance(address,uint256)",
    "decreaseAllowance(address,uint256)",
    "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
    "nonces(address)",
    "DOMAIN_SEPARATOR()",
    "eip712Domain()",
    "burn(uint256)",
    "burnFrom(address,uint256)",
    "owner()",
    "paused()",
  ].map((s) => toFunctionSelector(s)),
);
