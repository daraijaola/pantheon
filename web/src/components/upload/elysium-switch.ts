// Moving a wallet onto Elysium testnet, for the steps after Get uploaded that need it (staking, voting).
// Not used to sign in: a signature (personal_sign) needs no chain, so signing never switches.
//
// Ask the wallet to switch; if it doesn't know Elysium (4902, "Unrecognized chain", or a WalletConnect
// session that doesn't include it), add it with wallet_addEthereumChain, then switch again.

import { networkLabel } from "@/lib/network-copy";
import { numberToHex } from "viem";
import { elysium } from "@/lib/chain/config";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

export const ELYSIUM_HEX = numberToHex(elysium.id);

/** What wallet_addEthereumChain needs for Elysium testnet (EIP-3085). */
export const ELYSIUM_ADD = {
  chainId: ELYSIUM_HEX,
  chainName: elysium.name,
  nativeCurrency: elysium.nativeCurrency,
  rpcUrls: [...elysium.rpcUrls.default.http],
  blockExplorerUrls: [elysium.blockExplorers.default.url],
};

/** Every code and message in an error and the errors inside it (wallets and WalletConnect nest them). */
function details(e: unknown, depth = 0): { codes: number[]; text: string } {
  if (!e || typeof e !== "object" || depth > 4) return { codes: [], text: typeof e === "string" ? e : "" };
  const o = e as { code?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown; data?: { originalError?: unknown } };
  const inner = [o.cause, o.data?.originalError].map((x) => details(x, depth + 1));
  return {
    codes: [...(typeof o.code === "number" ? [o.code] : []), ...inner.flatMap((x) => x.codes)],
    text: [o.message, o.shortMessage].filter((x) => typeof x === "string").join(" ") + " " + inner.map((x) => x.text).join(" "),
  };
}

export const isRejected = (e: unknown) => {
  const { codes, text } = details(e);
  return codes.includes(4001) || codes.includes(5000) || /user rejected|rejected by user|user denied|cancel/i.test(text);
};

/** The wallet (or the WalletConnect session) doesn't have the chain yet. */
export const isUnknownChain = (e: unknown) => {
  const { codes, text } = details(e);
  return (
    codes.includes(4902) ||
    codes.includes(5100) || // WalletConnect: unsupported chains
    /unrecognized chain|unsupported chain|chain .*not (been )?(added|supported|configured)|try adding the chain|missing or invalid\. request\(\) chainId|wallet_addEthereumChain/i.test(text)
  );
};

export class SwitchError extends Error {}

/** Put the wallet on Elysium testnet, adding the chain first if it needs it. Throws a SwitchError
 * whose message can be shown as is. */
export async function switchToElysium(provider: Eip1193) {
  const doSwitch = () => provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ELYSIUM_HEX }] });
  try {
    await doSwitch();
    return;
  } catch (e) {
    if (isRejected(e)) throw new SwitchError("You cancelled the switch in your wallet.");
    if (!isUnknownChain(e)) throw new SwitchError(`Your wallet couldn’t switch to ${networkLabel}. Switch to it in your wallet, then try again.`);
  }
  try {
    await provider.request({ method: "wallet_addEthereumChain", params: [ELYSIUM_ADD] });
  } catch (e) {
    if (isRejected(e)) throw new SwitchError(`You cancelled adding ${networkLabel} in your wallet.`);
    throw new SwitchError(`Your wallet couldn’t add ${networkLabel}. Add it in your wallet (network ID ${elysium.id}), then try again.`);
  }
  // Some wallets switch as they add; asking again is harmless and covers the ones that don't.
  try {
    await doSwitch();
  } catch (e) {
    if (isRejected(e)) throw new SwitchError("You cancelled the switch in your wallet.");
    throw new SwitchError(`${networkLabel} is added, but your wallet didn’t switch to it. Switch in your wallet, then try again.`);
  }
}
