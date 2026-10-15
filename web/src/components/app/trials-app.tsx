"use client";

// The Trials vote: an inside screen, calm. PNTH stakers pick up to three coins with a free signature;
// the service (services/trials) checks it and counts 1 vote for the stake plus the Passport tier. Live
// counts refresh every few seconds, and every ballot is public, so anyone can recount.

import Link from "next/link";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useSignTypedData } from "wagmi";
import { deployment, elysium } from "@/lib/chain/config";
import { Providers } from "./providers";
import { NotLive, until, useNow, WalletBar, type Hex } from "./shared";
import s from "./app.module.css";
import t from "./trials.module.css";

export function TrialsApp() {
  if (!deployment) return <NotLive title="The Trials" line="The vote opens here as soon as PANTHEON is live on testnet." />;
  return (
    <Providers>
      <Trials />
    </Providers>
  );
}

// ------------------------------------------------------------------ what the service sends

type Verdict = "CLEAN" | "WATCH" | "NOT_ENOUGH_DATA";
type Coin = { token: Hex; symbol: string | null; verdict: Verdict; headline?: string; realUsdc: string; rank: number; votes: number; voters: number };
type Ballot = { voter: Hex; coins: Hex[]; weight: number; tier: number; signedAt: number };
type Current = {
  round: number;
  status: "upcoming" | "open" | "closed";
  opensAt: number;
  closesAt: number;
  seats: number;
  candidates: Coin[];
  leaders: Hex[];
  ballots: number;
  // weight = votes on each coin picked: 1 for staking PNTH, plus the Passport tier. Null if the chain didn't answer.
  you?: { voter: Hex; weight: number | null; tier: number | null; ballot: Ballot | null };
};

// The ballot's EIP-712 shape. It must match services/trials/src/ballot.ts exactly, or no vote will count.
const DOMAIN = { name: "PANTHEON Trials", version: "1", chainId: elysium.id } as const;
const TYPES = {
  Ballot: [
    { name: "round", type: "uint256" },
    { name: "voter", type: "address" },
    { name: "coins", type: "address[]" },
    { name: "signedAt", type: "uint64" },
  ],
} as const;

const SAY: Record<string, string> = {
  NO_VOTES: "This wallet has no PNTH staked, so it can’t vote yet. Stake any amount, then sign again.",
  BAD_SIGNATURE: "The signature didn’t match this wallet. Try again.",
  CLOSED: "This vote has closed.",
  NOT_OPEN: "This vote hasn’t opened yet.",
  STALE_SIGNATURE: "Your computer’s clock looks off by more than 10 minutes. Fix it and sign again.",
  TOO_MANY_COINS: "Pick fewer coins.",
  NOT_A_CANDIDATE: "One of those coins isn’t in this round.",
  RATE_LIMITED: "Too many tries. Wait a minute and sign again.",
  CHAIN_UNAVAILABLE: "We couldn’t read your stake from the chain just now. Try again in a minute.",
};
const VERDICT: Record<Verdict, string> = { CLEAN: "Clean", WATCH: "Watch", NOT_ENOUGH_DATA: "Not enough data" };
const usdc = (raw: string) => (Number(raw) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 });

// ------------------------------------------------------------------ the screen

function Trials() {
  const { address, isConnected, chainId } = useConnection();
  const onChain = isConnected && chainId === elysium.id;
  const voter = onChain ? address : undefined;
  const now = useNow();
  const qc = useQueryClient();
  const sign = useSignTypedData();
  const [picked, setPicked] = useState<Hex[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const q = useQuery({
    queryKey: ["trials", voter ?? ""],
    refetchInterval: 15_000,
    queryFn: async (): Promise<Current | null> => {
      const res = await fetch(`/api/trials/current${voter ? `?voter=${voter}` : ""}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      return (await res.json()) as Current;
    },
  });
  const r = q.data;

  if (q.isLoading) return <Shell sub="Reading the vote…" />;
  if (q.error) return <Shell sub="The vote service didn’t answer. Try again in a minute." />;
  if (!r) return <Shell sub="No vote is open right now. The next round opens here." />;

  const weight = r.you?.weight ?? null;
  const tier = r.you?.tier ?? 0;
  const staker = weight !== null && weight > tier;
  const mine = r.you?.ballot ?? null;
  // What's ticked: the voter's own picks once they start changing them, otherwise their saved ballot.
  const choice = picked ?? mine?.coins ?? [];
  const has = (c: Hex) => choice.some((x) => x.toLowerCase() === c.toLowerCase());
  const toggle = (c: Hex) => {
    setSent(false);
    setPicked(has(c) ? choice.filter((x) => x.toLowerCase() !== c.toLowerCase()) : choice.length < r.seats ? [...choice, c] : choice);
  };
  const canVote = r.status === "open" && onChain && (weight ?? 0) > 0;
  // A fixed order (by real trading), so rows never jump while someone is picking. Leaders show on the side.
  const coins = [...r.candidates].sort((a, b) => a.rank - b.rank);
  const top = Math.max(1, ...coins.map((c) => c.votes));
  const leaders = new Set(r.leaders.map((x) => x.toLowerCase()));

  const vote = async () => {
    if (!address || choice.length === 0) return;
    setError(null);
    setBusy("Waiting for your wallet…");
    try {
      const signedAt = Math.floor(Date.now() / 1000);
      const signature = await sign.mutateAsync({
        domain: DOMAIN,
        types: TYPES,
        primaryType: "Ballot",
        message: { round: BigInt(r.round), voter: address, coins: choice, signedAt: BigInt(signedAt) },
      } as Parameters<typeof sign.mutateAsync>[0]);
      setBusy("Counting your vote…");
      const res = await fetch("/api/trials/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ round: r.round, voter: address, coins: choice, signedAt, signature }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP_${res.status}`);
      setPicked(null);
      setSent(true);
      await qc.invalidateQueries({ queryKey: ["trials"] });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setError(/rejected|denied/i.test(msg) ? "You cancelled it in your wallet." : (SAY[msg] ?? msg.split("\n")[0]!));
    } finally {
      setBusy(null);
    }
  };

  const changed = picked !== null && (picked.length !== (mine?.coins.length ?? 0) || picked.some((c) => !mine?.coins.some((m) => m.toLowerCase() === c.toLowerCase())));
  const button = !onChain
    ? "Connect your wallet to vote"
    : r.status === "upcoming"
      ? "The vote hasn’t opened yet"
      : r.status === "closed"
        ? "This vote has closed"
        : weight === null
          ? "Checking your stake…"
          : weight === 0
            ? "Stake PNTH to vote"
            : choice.length === 0
              ? `Pick up to ${r.seats} coins`
              : mine && !changed
                ? "Your vote is in"
                : mine
                  ? "Sign my new vote (free)"
                  : "Sign my vote (free)";
  const clock = r.status === "upcoming" ? `Opens in ${until(r.opensAt - now)}` : r.status === "open" ? `Closes in ${until(r.closesAt - now)}` : "Closed";

  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>
            The Trials · round {r.round} · {clock}
          </p>
          <h1 className={s.h1}>Vote on the next basket</h1>
          <p className={s.sub}>
            Anyone with PNTH staked picks up to {r.seats} coins, and a HYPE Passport adds votes. The {r.seats} with the most votes join PANTHEON’s basket, and the other
            seats go to the coins with the most real trading. Voting is a free signature.
          </p>
        </div>
        <WalletBar />
      </header>

      <div className={s.grid}>
        <div className={s.main}>
          <section className={s.cell}>
            <p className={s.label}>Your vote</p>
            {!onChain ? (
              <p className={s.empty}>Connect the wallet you stake PNTH with.</p>
            ) : weight === 0 ? (
              <p className={s.empty}>
                This wallet has no PNTH staked, so it can’t vote yet. <Link href="/stake">Stake any amount of PNTH</Link> and come back. No PNTH?{" "}
                <Link href="/get">Get some free</Link>.
              </p>
            ) : weight === null ? (
              <p className={s.empty}>Checking your stake on the chain…</p>
            ) : (
              <p className={s.empty}>
                {staker && tier > 0
                  ? `Staking gives you 1 vote, and your tier ${tier} Passport adds ${tier}: ${weight} votes on each coin you pick.`
                  : staker
                    ? "Staking PNTH gives you 1 vote on each coin you pick. "
                    : `Your tier ${tier} Passport gives you ${tier} ${tier === 1 ? "vote" : "votes"} on each coin you pick. Staking PNTH adds 1 more.`}
                {staker && tier === 0 && (
                  <>
                    A <Link href="/passport/get">HYPE Passport</Link> adds up to 3 more.
                  </>
                )}
                {mine && !changed && ` You voted for ${mine.coins.map((c) => symOf(r, c)).join(", ")}. You can change it until the vote closes.`}
              </p>
            )}
          </section>

          <section className={s.cell}>
            <div className={s.rowHead}>
              <p className={s.label}>{r.candidates.length} coins can be voted in</p>
              <span className={t.picked}>
                {choice.length} of {r.seats} picked
              </span>
            </div>
            <div className={t.cols} aria-hidden>
              <span />
              <span>Real trading</span>
              <span>Votes</span>
            </div>
            <ul className={t.list}>
              {coins.map((c) => (
                <li key={c.token} className={has(c.token) ? t.rowOn : t.row}>
                  <label className={t.pick}>
                    <input type="checkbox" checked={has(c.token)} disabled={!canVote || (!has(c.token) && choice.length >= r.seats)} onChange={() => toggle(c.token)} />
                    <span className={t.coin}>
                      <span className={t.sym}>{c.symbol ?? `${c.token.slice(0, 6)}…`}</span>
                      <span className={t.pill}>{VERDICT[c.verdict]}</span>
                      {leaders.has(c.token.toLowerCase()) && c.votes > 0 && <span className={t.lead}>Leading</span>}
                    </span>
                  </label>
                  <span className={t.trade}>{usdc(c.realUsdc)} USDC</span>
                  <span className={t.bar} aria-hidden>
                    <i style={{ width: `${(c.votes / top) * 100}%` }} />
                  </span>
                  <span className={t.votes}>{c.votes}</span>
                  {c.headline && (
                    <Link href={`/delphi/${c.token}`} className={t.headline}>
                      {c.headline}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <button type="button" className={s.primary} disabled={!canVote || choice.length === 0 || !!busy || (!!mine && !changed)} onClick={vote}>
              {busy ?? button}
            </button>
            {error && <p className={s.error}>{error}</p>}
            {sent && !error && <p className={s.hint}>Counted. You can change your vote until it closes; your newest signature is the one that counts.</p>}
          </section>
        </div>

        <aside className={s.side}>
          <div className={s.cell}>
            <p className={s.label}>Leading now</p>
            {r.leaders.length === 0 ? (
              <p className={s.empty}>No votes yet.</p>
            ) : (
              <ol className={t.leaders}>
                {r.leaders.map((x) => {
                  const c = r.candidates.find((y) => y.token.toLowerCase() === x.toLowerCase())!;
                  return (
                    <li key={x}>
                      <span>{c.symbol ?? x}</span>
                      <span className={s.num}>
                        {c.votes} {c.votes === 1 ? "vote" : "votes"}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
            <p className={s.hint}>
              {r.ballots} {r.ballots === 1 ? "ballot" : "ballots"} so far.
            </p>
          </div>
          <div className={s.cell}>
            <p className={s.label}>How it works</p>
            <ul className={t.rules}>
              <li>One wallet is one voter. Staking PNTH gives 1 vote on each coin you pick, and a HYPE Passport adds 1, 2 or 3 more.</li>
              <li>Only coins DELPHI hasn’t flagged, with real trading, old enough to enter the basket.</li>
              <li>When it closes, the new list goes on-chain and waits 24 hours, and the guardian can veto it.</li>
            </ul>
          </div>
          <div className={s.cell}>
            <p className={s.label}>Every ballot is public</p>
            <p className={s.hint}>
              Each vote is a signed message, published with its signature, so anyone can recount it.{" "}
              <a href={`/api/trials/rounds/${r.round}`} target="_blank" rel="noreferrer">
                See every ballot
              </a>
              .
            </p>
          </div>
        </aside>
      </div>
      <p className={s.fine}>
        Testnet: these are test coins with no value. <Link href="/trials">How the Trials work</Link>
      </p>
    </main>
  );
}

const symOf = (r: Current, token: Hex) => r.candidates.find((c) => c.token.toLowerCase() === token.toLowerCase())?.symbol ?? `${token.slice(0, 6)}…`;

function Shell({ sub }: { sub: string }) {
  return (
    <main className={s.page}>
      <header className={s.head}>
        <div>
          <p className={s.eyebrow}>The Trials</p>
          <h1 className={s.h1}>Vote on the next basket</h1>
          <p className={s.sub}>{sub}</p>
        </div>
        <WalletBar />
      </header>
    </main>
  );
}
