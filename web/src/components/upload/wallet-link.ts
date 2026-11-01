// Phone wallets over WalletConnect: once connected, signing happens in the wallet app, so tapping "Sign
// message" on a phone has to take the user there. WalletConnect's SDK tries to itself, but only while it
// still remembers the wallet picked in its window, and only after a few awaits, by which time a phone
// browser may no longer count it as the user's tap. So the tap opens the wallet itself, straight away.

/** Where WalletConnect's window keeps the wallet picked in it: {"name","href"}, href like "metamask://". */
export const CHOICE_KEY = "WALLETCONNECT_DEEPLINK_CHOICE";

/** What a wallet says about how to open it, from the WalletConnect session (peer.metadata.redirect). */
export type PeerRedirect = { native?: unknown; universal?: unknown } | undefined;

export const isIos = (ua: string, touchPoints = 0) => /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
export const isMobile = (ua: string, touchPoints = 0) => /Android|Mobi/i.test(ua) || isIos(ua, touchPoints);

const isWeb = (link: string) => /^https:\/\//i.test(link);
/** An app link (metamask://, trust://) or an https link. Never javascript:, data: and the like. */
function usable(link: unknown): link is string {
  if (typeof link !== "string") return false;
  const l = link.trim();
  return isWeb(l) || (/^[a-z][a-z0-9+.-]*:\/\//i.test(l) && !/^(javascript|data|vbscript|file|blob|http|about):/i.test(l));
}

/** The href of the wallet picked in WalletConnect's window, if one was saved. */
export function choiceHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const href = (JSON.parse(raw) as { href?: unknown } | null)?.href;
    return usable(href) ? href.trim() : undefined;
  } catch {
    return usable(raw) ? raw.trim() : undefined;
  }
}

/** The link that opens the connected wallet app, or null when none is known. The wallet picked in the
 * window first (it's the one that opened at connect), then what the wallet itself says: its universal
 * link first on iPhone, its app link first elsewhere. */
export function walletLink(choice: string | null | undefined, peer: PeerRedirect, ios: boolean): string | null {
  const picked = choiceHref(choice);
  if (picked) return picked;
  const native = usable(peer?.native) && !isWeb(peer.native.trim()) ? peer.native.trim() : undefined;
  const universal = usable(peer?.universal) && isWeb(peer.universal.trim()) ? peer.universal.trim() : undefined;
  return (ios ? (universal ?? native) : (native ?? universal)) ?? null;
}

/** Open the wallet. An app link in place, so this page and its pending request stay as they are; an
 * https link in a new tab, so if the app isn't installed this page still isn't navigated away. */
export function openWallet(link: string, w: Window = window) {
  if (isWeb(link)) w.open(link, "_blank", "noopener,noreferrer");
  else w.location.href = link;
}

/** localStorage, without throwing where it's blocked. */
export const store = {
  get(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Blocked (private mode): nothing to keep.
    }
  },
  remove(key: string) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Blocked (private mode): nothing to keep.
    }
  },
};

/** The bits of WalletConnect's EthereumProvider used to sign. */
export type PhoneProvider = {
  chainId?: number;
  session?: { namespaces?: Record<string, { accounts?: string[] }> };
  signer?: { request(a: { method: string; params: unknown[] }, chain: string): Promise<unknown> };
  request(a: { method: string; params: unknown[] }): Promise<unknown>;
};

/** The eip155 chains the wallet approved in the WalletConnect session ("eip155:1:0xabc…" → 1). */
export const sessionChains = (p: PhoneProvider) => [
  ...new Set((p.session?.namespaces?.eip155?.accounts ?? []).map((a) => Number(a.split(":")[1])).filter((n) => Number.isInteger(n) && n > 0)),
];

/** Send a request that needs no particular chain (personal_sign) on a chain the session has: the one the
 * provider is on, else the session's first. Never asks the wallet to switch. */
export function signOnSession(p: PhoneProvider, request: { method: string; params: unknown[] }) {
  const chains = sessionChains(p);
  if (!chains.length || chains.includes(Number(p.chainId)) || !p.signer) return p.request(request);
  return p.signer.request(request, `eip155:${chains[0]}`);
}
