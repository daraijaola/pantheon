"use client";

// The HYPE Passport screen: link a Hyperliquid wallet to this Elysium wallet with one or two
// signatures, then see the Passport (portrait, tier, boost, votes, badges). The signing and the
// Hyperliquid check happen in the Passport service (/api/passport); the chain is the source of truth.
// Calm, like every app screen.

/* eslint-disable @next/next/no-img-element -- small local portraits, already optimised */

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isAddress, keccak256, zeroAddress } from "viem";
import { useConnection, useReadContracts, useSignTypedData } from "wagmi";
import { hypePassportRegistryAbi, pantheonStakingAbi } from "@/lib/chain/abi";
import { deployment, elysium, explorer } from "@/lib/chain/config";
import type { Deployment } from "@/lib/chain/deployments";
import { Providers } from "./providers";
import { NotLive, short, TxNote, until, useChainNow, useTx, WalletBar, type Hex } from "./shared";
import s from "./app.module.css";

const PORTRAITS = [
  "caspian", "maddie", "maddie-orb", "maddie-adult", "david", "david-young", "ellen", "cary",
  "holstrom", "yair", "mist", "joey", "laurie", "renee", "pope",
];
/** Every wallet gets one of the code portraits, picked from its address, always the same one. */
const portraitFor = (a: string) => PORTRAITS[parseInt(keccak256(a.toLowerCase() as Hex).slice(2, 10), 16) % PORTRAITS.length];

const TIERS = [
  { tier: 1, need: "10 HYPE", boost: "1.10×", votes: 1 },
  { tier: 2, need: "100 HYPE and a 30-day-old account", boost: "1.20×", votes: 2 },
  { tier: 3, need: "1,000 HYPE and a 90-day-old account", boost: "1.25×", votes: 3 },
];

const SAY: Record<string, string> = {
  SCORE_BELOW_10: "Less than 10 HYPE counted. Staked HYPE counts in full; HYPE you hold but haven’t staked counts half.",
  SCORE_BELOW_100: "Under 100 HYPE: that’s the next tier.",
  SCORE_BELOW_1000: "Under 1,000 HYPE: that’s the top tier.",
  ACCOUNT_AGE_BELOW_30D: "Your Hyperliquid account is less than 30 days old.",
  ACCOUNT_AGE_BELOW_90D: "Your Hyperliquid account is less than 90 days old.",
  NO_HYPERCORE_HISTORY: "This wallet has never been used on Hyperliquid.",
  PARTIAL_EVM_READ: "Part of your HyperEVM balance couldn’t be read. Try again in a few minutes.",
  AGENT_WALLET: "That’s an API (agent) wallet. Use the main wallet that holds your HYPE.",
  NOT_A_SIGNING_ACCOUNT: "That account can’t sign for itself (a vault or sub-account). Use your main wallet.",
  MULTISIG_UNSUPPORTED: "Multi-signature Hyperliquid accounts aren’t supported yet.",
  HL_ALREADY_LINKED: "That Hyperliquid wallet is already linked to another Elysium wallet.",
  ACCOUNT_ALREADY_LINKED: "This Elysium wallet is already linked to another Hyperliquid wallet.",
  REBIND_COOLDOWN: "That Hyperliquid wallet was unlinked recently. It can link again 7 days after.",
  RATE_LIMITED: "Too many tries. Wait a minute and try again.",
  CHALLENGE_EXPIRED: "That took longer than 15 minutes. Start again.",
  CHALLENGE_USED: "That request was already used. Start again.",
  CHALLENGE_NOT_FOUND: "That request wasn’t found. Start again.",
  BAD_HL_SIGNATURE: "The signature didn’t come from that Hyperliquid wallet.",
  BAD_ELYSIUM_SIGNATURE: "The signature didn’t come from your Elysium wallet.",
  INVALID_ADDRESS: "That isn’t a valid wallet address.",
  HTTP_500: "The Passport service isn’t running yet. Try again soon.",
  HTTP_502: "The Passport service isn’t running yet. Try again soon.",
  HTTP_503: "The Passport service is busy. Try again in a minute.",
  HTTP_504: "The Passport service took too long. Try again in a minute.",
};
const say = (code: string) => SAY[code] ?? `The Passport service said: ${code}.`;
const badge = (name: string) =>
  ({ GENESIS: "Genesis holder", HYPURR: "Hypurr", KNTQ: "KNTQ holder", SEASONED: "Seasoned" })[name] ??
  name.charAt(0) + name.slice(1).toLowerCase().replace(/_/g, " ");

type TypedData = { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
type Challenge = { nonce: Hex; typedData: TypedData; e: Hex; h: Hex; hlSig?: Hex; elySig?: Hex };
type Verified = { tier: number; reasons?: string[]; multiplier?: string; txHash?: Hex };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/passport${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const json = await res.json().catch(() => ({}));
  if (res.status >= 500 && !json.error) throw new Error(`HTTP_${res.status}`);
  if (!res.ok) throw new Error(json.error ?? `HTTP_${res.status}`);
  return json as T;
}

export function PassportApp() {
  if (!deployment) return <NotLive title="HYPE Passport" line="PANTHEON isn’t live on testnet yet. Passports open here the moment it is." />;
  return (
    <Providers>
      <Passport d={deployment} />
    </Providers>
  );
}

function Passport({ d }: { d: Deployment }) {
  const { address, isConnected, chainId } = useConnection();
  const onChain = isConnected && chainId === elysium.id;
  const me = (address ?? zeroAddress) as Hex;

  const chain = useReadContracts({
    contracts: [
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "passportOf", args: [me] },
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "isValid", args: [me] },
      { address: d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "multiplierOf", args: [me] },
      { address: d.staking, abi: pantheonStakingAbi, functionName: "accounts", args: [me] },
      { address: d.staking, abi: pantheonStakingAbi, functionName: "workingOf", args: [me] },
    ],
    query: { enabled: onChain, refetchInterval: 6_000 },
  });
  const passport = chain.data?.[0].result;
  const valid = chain.data?.[1].result ?? false;
  const mult = Number(chain.data?.[2].result ?? 10n ** 18n) / 1e18;
  const stored = chain.data?.[3].result?.[2] ?? 0n; // the working balance staking last saw
  const fresh = chain.data?.[4].result ?? 0n; // what it would be now
  const service = useQuery({
    queryKey: ["passport", me],
    queryFn: () => api<{ stampNames: string[] }>(`/${me}`),
    enabled: onChain && valid,
  });

  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>App · Elysium testnet</p>
          <h1 className={s.h1}>HYPE Passport</h1>
          <p className={s.sub}>Prove you hold HYPE with one signature. Nothing leaves your wallet, and your address stays private.</p>
        </div>
        <WalletBar />
      </header>

      <div className={s.grid}>
        <section className={s.main}>
          {!onChain ? (
            <div className={s.cell}>
              <p className={s.empty}>Connect your Elysium wallet to see or get your Passport.</p>
            </div>
          ) : valid && passport ? (
            <PassportCard
              d={d}
              me={me}
              tier={passport.tier}
              mult={mult}
              expiry={Number(passport.expiry)}
              linkedAt={Number(passport.linkedAt)}
              stamps={service.data?.stampNames ?? []}
              boostWaiting={fresh !== stored && stored > 0n}
            />
          ) : (
            <LinkFlow me={me} />
          )}
        </section>

        <aside className={s.side}>
          <div className={s.cell}>
            <p className={s.label}>The tiers</p>
            <ul className={s.tiers}>
              {TIERS.map((t) => (
                <li key={t.tier}>
                  <span className={s.tierName}>Tier {t.tier}</span>
                  <span className={s.tierNeed}>{t.need}</span>
                  <span className={s.num}>
                    {t.boost} · {t.votes} {t.votes === 1 ? "vote" : "votes"}
                  </span>
                </li>
              ))}
            </ul>
            <p className={s.hint}>HYPE counted = your staked HYPE + half of the HYPE you hold. Checked again every day.</p>
          </div>
          <p className={s.fine}>
            Only your tier and a private code go on-chain, never your Hyperliquid address or balances. <Link href="/passport">How it works</Link>
          </p>
        </aside>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ getting one

function LinkFlow({ me }: { me: Hex }) {
  const { address: current } = useConnection();
  const sign = useSignTypedData();
  const qc = useQueryClient();
  const [hl, setHl] = useState("");
  const [ch, setCh] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Verified | null>(null);

  const same = ch ? ch.e.toLowerCase() === ch.h.toLowerCase() : false;
  const isCurrent = (a: Hex) => current?.toLowerCase() === a.toLowerCase();

  const start = async () => {
    setError(null);
    setResult(null);
    if (!isAddress(hl)) return setError(say("INVALID_ADDRESS"));
    setBusy("Checking that wallet…");
    try {
      const c = await api<{ nonce: Hex; typedData: TypedData }>("/challenge", { elysiumAccount: me, hyperliquidAccount: hl });
      setCh({ nonce: c.nonce, typedData: c.typedData, e: me, h: hl as Hex });
    } catch (e) {
      setError(say((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  const signWith = async (who: "h" | "e") => {
    if (!ch) return;
    setError(null);
    setBusy("Waiting for your wallet…");
    try {
      const t = ch.typedData;
      const message = { ...t.message, deadline: BigInt(String(t.message.deadline)), chainId: BigInt(String(t.message.chainId)) };
      const sig = await sign.mutateAsync({
        account: who === "h" ? ch.h : ch.e,
        domain: t.domain,
        types: t.types,
        primaryType: t.primaryType,
        message,
      } as Parameters<typeof sign.mutateAsync>[0]);
      setCh(who === "h" ? { ...ch, hlSig: sig, ...(same ? { elySig: sig } : {}) } : { ...ch, elySig: sig });
    } catch (e) {
      setError(/rejected|denied/i.test(String(e)) ? "You cancelled it in your wallet." : String((e as Error).message).split("\n")[0]);
    } finally {
      setBusy(null);
    }
  };

  const issue = async () => {
    if (!ch?.hlSig) return;
    setError(null);
    setBusy("Checking your HYPE on Hyperliquid…");
    try {
      const r = await api<Verified>("/verify", {
        nonce: ch.nonce,
        hlSignature: ch.hlSig,
        ...(same ? {} : { elysiumSignature: ch.elySig }),
        relay: true,
      });
      setResult(r);
      setCh(null);
      await qc.invalidateQueries();
    } catch (e) {
      setError(say((e as Error).message));
    } finally {
      setBusy(null);
    }
  };

  if (result && result.tier === 0) {
    return (
      <div className={s.cell}>
        <p className={s.label}>Not yet</p>
        <p className={s.lead}>That wallet doesn’t reach Tier 1 yet, so no Passport was issued and nothing was linked.</p>
        <ul className={s.reasons}>
          {(result.reasons ?? []).map((r) => (
            <li key={r}>{say(r)}</li>
          ))}
        </ul>
        <button type="button" className={s.ghost} onClick={() => setResult(null)}>
          Try another wallet
        </button>
      </div>
    );
  }

  return (
    <div className={s.cell}>
      <p className={s.label}>Get your Passport</p>
      <div className={s.list}>
        <div className={s.row}>
          <span>Your Elysium wallet</span>
          <span className={s.num}>{short(me)}</span>
        </div>
      </div>
      {!ch ? (
        <>
          <label className={s.field}>
            <span className={s.fieldTop}>
              <span>Your Hyperliquid wallet</span>
              <button type="button" className={s.max} onClick={() => setHl(me)}>
                It’s this same wallet
              </button>
            </span>
            <span className={s.inputRow}>
              <input className={s.addrInput} placeholder="0x…" value={hl} onChange={(e) => setHl(e.target.value.trim())} spellCheck={false} />
            </span>
          </label>
          <p className={s.hint}>The wallet that holds your HYPE on Hyperliquid. Its main wallet, not an API wallet.</p>
          <button type="button" className={s.primary} disabled={!hl || !!busy} onClick={start}>
            {busy ?? "Check my HYPE"}
          </button>
        </>
      ) : (
        <ol className={s.steps}>
          <Step
            done={!!ch.hlSig}
            title={`Sign with your Hyperliquid wallet ${short(ch.h)}`}
            note={isCurrent(ch.h) ? "Free: a signature, not a transaction." : `Switch your wallet to ${short(ch.h)} to sign.`}
            action={
              !ch.hlSig && (
                <button type="button" className={s.primarySmall} disabled={!isCurrent(ch.h) || !!busy} onClick={() => signWith("h")}>
                  Sign
                </button>
              )
            }
          />
          {!same && (
            <Step
              done={!!ch.elySig}
              title={`Sign with your Elysium wallet ${short(ch.e)}`}
              note={isCurrent(ch.e) ? "The same message, so both wallets agree." : `Switch your wallet back to ${short(ch.e)}.`}
              action={
                !ch.elySig && (
                  <button type="button" className={s.primarySmall} disabled={!ch.hlSig || !isCurrent(ch.e) || !!busy} onClick={() => signWith("e")}>
                    Sign
                  </button>
                )
              }
            />
          )}
          <Step
            done={false}
            title="Issue my Passport"
            note="We check your HYPE on Hyperliquid and write your Passport on Elysium. We pay the gas."
            action={
              <button type="button" className={s.primarySmall} disabled={!ch.hlSig || (!same && !ch.elySig) || !!busy} onClick={issue}>
                Issue
              </button>
            }
          />
        </ol>
      )}
      {busy && ch && <p className={s.hint}>{busy}</p>}
      {result && result.tier > 0 && <p className={s.hint}>Your Passport is issued.</p>}
      {error && <p className={s.error}>{error}</p>}
      {ch && (
        <button type="button" className={s.linkBtn} onClick={() => setCh(null)}>
          Start again
        </button>
      )}
    </div>
  );
}

function Step({ done, title, note, action }: { done: boolean; title: string; note: string; action: React.ReactNode }) {
  return (
    <li className={s.step}>
      <span className={done ? s.stepDone : s.stepMark} aria-hidden="true">
        {done ? "✓" : ""}
      </span>
      <span className={s.stepText}>
        <span className={s.stepTitle}>{title}</span>
        <span className={s.stepNote}>{note}</span>
      </span>
      <span>{action}</span>
    </li>
  );
}

// ------------------------------------------------------------------ having one

function PassportCard(p: {
  d: Deployment;
  me: Hex;
  tier: number;
  mult: number;
  expiry: number;
  linkedAt: number;
  stamps: string[];
  boostWaiting: boolean;
}) {
  const now = useChainNow();
  const { run, busy, error, lastTx } = useTx();
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const votes = TIERS.find((t) => t.tier === p.tier)?.votes ?? 0;

  const recheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await api("/refresh", { elysiumAccount: p.me });
      await qc.invalidateQueries();
    } catch (e) {
      setCheckError(say((e as Error).message));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className={s.cell}>
      <div className={s.passport}>
        <img src={`/portraits/${portraitFor(p.me)}.png`} alt="" className={s.portrait} />
        <div className={s.passportBody}>
          <p className={s.label}>Your Passport</p>
          <p className={s.tierBig}>Tier {p.tier}</p>
          <div className={s.stats}>
            <div className={s.stat}>
              <span className={s.statK}>Staking boost</span>
              <span className={s.statVStrong}>{p.mult.toFixed(2)}×</span>
            </div>
            <div className={s.stat}>
              <span className={s.statK}>Votes in the Trials</span>
              <span className={s.statVStrong}>{votes}</span>
              <span className={s.statNote}>
                <Link href="/trials/vote">Vote in the Trials</Link>
              </span>
            </div>
            <div className={s.stat}>
              <span className={s.statK}>Valid for</span>
              <span className={s.statV}>{until(Math.max(p.expiry - now, 0))}</span>
              <span className={s.statNote}>renews every day while you hold</span>
            </div>
          </div>
          {p.stamps.length > 0 && (
            <div className={s.badges}>
              {p.stamps.map((n) => (
                <span key={n} className={s.badge}>
                  {badge(n)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {p.boostWaiting && (
        <div className={s.unlock}>
          <span>Your stake doesn’t have this boost yet.</span>
          <button
            type="button"
            className={s.primarySmall}
            disabled={!!busy}
            onClick={() => run("Applying", [{ address: p.d.staking, abi: pantheonStakingAbi, functionName: "poke", args: [[p.me]] } as const])}
          >
            {busy ?? "Apply the boost"}
          </button>
        </div>
      )}
      <div className={s.actionsRow}>
        <button type="button" className={s.ghost} disabled={checking} onClick={recheck}>
          {checking ? "Checking…" : "Check my HYPE again"}
        </button>
        {!confirmUnlink ? (
          <button type="button" className={s.linkBtn} onClick={() => setConfirmUnlink(true)}>
            Unlink
          </button>
        ) : (
          <button
            type="button"
            className={s.ghost}
            disabled={!!busy}
            onClick={() => run("Unlinking", [{ address: p.d.passportRegistry, abi: hypePassportRegistryAbi, functionName: "unlink" } as const])}
          >
            {busy ?? "Yes, unlink (your boost ends)"}
          </button>
        )}
      </div>
      <p className={s.hint}>
        Linked since {new Date(p.linkedAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.{" "}
        <a href={explorer("address", p.d.passportRegistry)} target="_blank" rel="noreferrer">
          The registry
        </a>
      </p>
      {checkError && <p className={s.error}>{checkError}</p>}
      <TxNote error={error} lastTx={lastTx} />
    </div>
  );
}
