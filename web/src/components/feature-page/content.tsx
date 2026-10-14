// What each feature page says. Only what is built is stated as fact (the contracts, the Passport
// service, DELPHI); the Trials vote is named as coming. Plain words only.

import { BallotCard, CovenantCard, PassportCard } from "./cards";
import type { Feature } from "./feature-page";

export const PASSPORT: Feature = {
  eyebrow: "HYPE Passport",
  title: (
    <>
      Prove you hold HYPE.
      <br />
      <span>Earn more from staking.</span>
    </>
  ),
  sub: "One signature links your Hyperliquid wallet to Elysium. Your Passport then boosts what you earn from staking PNTH, and any app on Elysium can read it.",
  actions: [
    { label: "Get your Passport", href: "/passport/get", primary: true },
    { label: "See the tiers", href: "#details" },
  ],
  diagram: <PassportCard />,
  steps: [
    { title: "Link your wallets", desc: "Sign one message with your Hyperliquid wallet to link it to your Elysium wallet. No funds move." },
    { title: "We count your HYPE", desc: "Staked HYPE counts in full, HYPE you hold but haven’t staked counts half, and older accounts reach higher tiers." },
    { title: "Use it everywhere", desc: "Your tier boosts PNTH staking, and any app on Elysium can read it. Next, it will set your votes in the Trials." },
  ],
  details: {
    title: "The tiers",
    sub: "Your tier is checked again every day, so it follows your HYPE up and down.",
    head: ["Tier", "You need", "Staking boost", "Votes (soon)"],
    rows: [
      ["Tier 1", "10 HYPE", "1.10×", "1"],
      ["Tier 2", "100 HYPE and an account at least 30 days old", "1.20×", "2"],
      ["Tier 3", "1,000 HYPE and an account at least 90 days old", "1.25×", "3"],
    ],
    note: "HYPE counted = your staked HYPE + half of the HYPE you hold but haven’t staked.",
  },
  faq: [
    {
      q: "Does anyone see my Hyperliquid address?",
      a: "We read it to work out your tier, but only the tier and a private code are written on-chain. Your address and balances are never published.",
    },
    { q: "Do I have to move my HYPE?", a: "No. Nothing leaves your wallet. You only sign a message to prove the wallet is yours." },
    {
      q: "What if I sell my HYPE?",
      a: "Your tier is re-checked every day. If your HYPE drops below a tier, your boost drops with it.",
    },
    { q: "Can other apps use my Passport?", a: "Yes. The Passport is open: any app on Elysium can read a wallet’s tier and build on it." },
  ],
};

export const TRIALS: Feature = {
  eyebrow: "The Trials",
  title: (
    <>
      Up to ten coins.
      <br />
      <span>Earned, not bought.</span>
    </>
  ),
  sub: "Coins make the basket on their real trading, and a coin DELPHI flags for cheating can never get in. Every change waits a day on-chain and can be vetoed. Next, HYPE Passport holders vote three coins in.",
  actions: [
    { label: "Read the rules", href: "#details", primary: true },
    { label: "See the basket", href: "/#basket" },
  ],
  diagram: <BallotCard />,
  steps: [
    {
      title: "Scored in the open",
      desc: "DELPHI checks every Ascend coin and ranks it on real trading, with wash trades taken out. Each round’s data is published, so anyone can check the pick.",
    },
    { title: "A day to say no", desc: "A new list waits 24 hours on-chain before it starts. In that time a separate guardian key can veto it. It can stop a list, never add one." },
    {
      title: "Three seats, one vote",
      desc: "Coming next: each week Passport holders vote three more coins in. A vote will be a free signature, and higher tiers will carry more votes.",
    },
  ],
  details: {
    title: "The rules every coin must pass",
    sub: "They are the same for every coin, with no exceptions.",
    head: ["Rule", "What it means"],
    rows: [
      ["Age", "A coin must be at least 3 days old."],
      ["Market", "It must trade against USDC on Ascend."],
      ["Size", "No coin can be more than 20% of the basket, and it holds at most ten."],
      ["Clean", "A coin DELPHI flags for cheating can never get in."],
      ["Changes", "Every change waits 24 hours, and the guardian can veto it."],
      ["Votes", "Coming next: one Passport, counted by its tier: 1, 2 or 3 votes."],
    ],
  },
  faq: [
    { q: "Can a coin pay to get in?", a: "No. Paying PANTHEON gives a coin no advantage in the score or the vote." },
    {
      q: "How is a coin scored?",
      a: "Round 1 ranked coins on their real USDC trading, after DELPHI took out wash trading, and kept flagged coins out. The ranking file is public, and the proposal on-chain carries its fingerprint.",
    },
    { q: "When does voting start?", a: "After PNTH launches. Until then, the basket is picked on the numbers alone." },
    {
      q: "Who can veto?",
      a: "A guardian key, separate from the one that proposes lists. It can only stop a list, never add one. We’d like Ascend to hold it.",
    },
  ],
};

export const COVENANT: Feature = {
  eyebrow: "Covenant",
  title: (
    <>
      No owner.
      <br />
      <span>Rules locked.</span>
    </>
  ),
  sub: "Covenant is the contract that collects PANTHEON’s share of every trade fee and does exactly what it was told at launch. No one can change it, including us. Any Ascend creator can launch a coin on it too.",
  actions: [
    { label: "Launch a coin on Covenant", href: "/covenant/launch", primary: true },
    { label: "Read the rules", href: "#details" },
  ],
  diagram: <CovenantCard />,
  steps: [
    {
      title: "It takes the fees",
      desc: "On Ascend, a coin’s creator gets half of every 1% trade fee. For PNTH, the creator is Covenant: a contract, not a person.",
    },
    {
      title: "It does its jobs",
      desc: "On buys, the fee buys the basket and pays it out to stakers. On sells, it burns PNTH. Every action leaves a public receipt.",
    },
    { title: "Nobody can change it", desc: "There is no owner, no admin key and no upgrade. Its jobs were set the moment it was created." },
  ],
  details: {
    title: "Any Ascend coin can use it",
    sub: "PNTH is the first coin on Covenant. Any creator can now launch a coin whose fees get jobs that can’t be undone.",
    head: ["Job", "What the fees do"],
    rows: [
      ["Burn", "Burn the fees paid in the coin, so its supply only goes down."],
      ["Pay", "Send a share to a wallet chosen at launch, like the team’s."],
      ["PANTHEON", "Send a share of the USDC fees to the PANTHEON basket."],
      ["Stream", "Pay a share out over a day through a staking contract."],
    ],
    note: "Fees paid in the coin can be burned, paid or streamed. Fees paid in USDC can be paid, sent to the PANTHEON basket or streamed. Up to six jobs a side.",
  },
  faq: [
    { q: "Can the PANTHEON team take the fees?", a: "No. The fees go to the contract, and the contract can only do the jobs it was given." },
    {
      q: "What if something needs fixing?",
      a: "It can’t be upgraded, so it is kept small and simple, and its code is public for anyone to review before launch.",
    },
    {
      q: "Where can I see it?",
      a: (
        <>
          PNTH’s Covenant is live on the Elysium testnet at{" "}
          <a href="https://elysium.kinetiq.xyz/testnet-explorer/address/0xE0Fb49DBDC3406cF1f175EeCABDFb282a7a98b66" target="_blank" rel="noreferrer">
            0xE0Fb…8b66
          </a>
          . Every burn and payment it makes is on the explorer, and its code is verified there.
        </>
      ),
    },
  ],
};
