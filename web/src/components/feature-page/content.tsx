// What each feature page says. Only what is built is stated as fact (the contracts, the Passport
// service, DELPHI, the Trials vote). Plain words only.

import { BallotCard, CovenantCard, KeysCard, PassportCard } from "./cards";
import type { Feature } from "./feature-page";

export const PASSPORT: Feature = {
  eyebrow: "HYPE Passport",
  title: (
    <>
      Prove you hold HYPE.
      <br />
      <span>Earn more, and get a vote.</span>
    </>
  ),
  sub: "One signature links your Hyperliquid wallet to Elysium. Your Passport then boosts what you earn from staking PNTH and gives you votes in the Trials.",
  actions: [
    { label: "Get your Passport", href: "/passport/get", primary: true },
    { label: "See the tiers", href: "#details" },
  ],
  diagram: <PassportCard />,
  steps: [
    { title: "Link your wallets", desc: "Sign one message with your Hyperliquid wallet to link it to your Elysium wallet. No funds move." },
    { title: "We count your HYPE", desc: "Staked HYPE counts in full, HYPE you hold but haven’t staked counts half, and older accounts reach higher tiers." },
    { title: "Use it everywhere", desc: "Your tier boosts PNTH staking and sets your votes in the Trials. Any app on Elysium can read it too." },
  ],
  details: {
    title: "The tiers",
    sub: "Your tier is checked again every day, so it follows your HYPE up and down.",
    head: ["Tier", "You need", "Staking boost", "Votes"],
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
      a: "Your tier is re-checked every day. If your HYPE drops below a tier, your boost and votes drop with it.",
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
  sub: "HYPE Passport holders vote three coins into the basket each round, and the rest earn their place on real trading. A coin DELPHI flags for cheating can never get in, and every change waits a day on-chain.",
  actions: [
    { label: "Vote now", href: "/trials/vote", primary: true },
    { label: "Read the rules", href: "#details" },
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
      desc: "Each round, Passport holders vote three coins in. A vote is a free signature, and higher tiers carry more votes.",
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
      ["Votes", "One Passport, counted by its tier: 1, 2 or 3 votes on each coin it picks."],
    ],
  },
  faq: [
    { q: "Can a coin pay to get in?", a: "No. Paying PANTHEON gives a coin no advantage in the score or the vote." },
    {
      q: "How is a coin scored?",
      a: "Round 1 ranked coins on their real USDC trading, after DELPHI took out wash trading, and kept flagged coins out. The ranking file is public, and the proposal on-chain carries its fingerprint.",
    },
    {
      q: "How do I vote?",
      a: "Get a HYPE Passport, then pick up to three coins on the vote page and sign. It’s free, and you can change your vote until it closes. Every ballot is published with its signature, so anyone can recount.",
    },
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
      desc: "On buys, 85% of the fee buys the basket for stakers. On sells, 85% burns PNTH. 15% of both pays the team. Every action leaves a public receipt.",
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
    {
      q: "Can the PANTHEON team take the fees?",
      a: "Only its fixed share: 15% of PNTH’s fees pay the team, set when PNTH launches on mainnet and impossible to raise. The rest can only be burned or go to the basket. On testnet the team’s share is 0%.",
    },
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

const EXPLORER = "https://elysium.kinetiq.xyz/testnet-explorer/address/";
const at = (address: string) => (
  <a href={EXPLORER + address} target="_blank" rel="noreferrer">
    {address.slice(0, 6)}…{address.slice(-4)}
  </a>
);

export const SECURITY: Feature = {
  eyebrow: "Security",
  title: (
    <>
      Every rule is in the code.
      <br />
      <span>Check it yourself.</span>
    </>
  ),
  sub: "PANTHEON is live on the Elysium testnet and hasn’t been audited yet. This page lists every contract, every key and what it can do, and how we test them.",
  actions: [
    { label: "See every contract", href: "#details", primary: true },
    { label: "Read DELPHI", href: "/delphi" },
  ],
  diagram: <KeysCard />,
  steps: [
    {
      title: "No owner where the money is",
      desc: "Covenant, staking and the basket vault have no owner, no admin key and no upgrade. Nobody can take what they hold, including us.",
    },
    {
      title: "Small, slow powers",
      desc: "The keys that exist can only propose or block a basket list, which waits 24 hours, or sign Passports that expire within 8 days. Staking caps any Passport boost at 1.25×.",
    },
    {
      title: "Tested against real Ascend",
      desc: "24 contract tests, 7 of them against a copy of Ascend’s live testnet, including a 1,000-run test that stakers can never be paid more than came in. Slither, the standard automatic checker, found nothing real.",
    },
  ],
  details: {
    title: "Every contract",
    sub: "All live on the Elysium testnet. Every contract we wrote is verified on the explorer. PNTH itself is a standard Ascend token, made by Ascend’s launchpad.",
    head: ["Contract", "What it does", "Address"],
    rows: [
      ["PNTH", "The token: a standard Ascend coin with a fixed supply of 1 billion.", at("0x048aCeb334cb1835dc897a749C5985e169EAb1C5")],
      ["Covenant for PNTH", "Takes PNTH’s fees and does its jobs: burn on sells, basket on buys.", at("0xE0Fb49DBDC3406cF1f175EeCABDFb282a7a98b66")],
      ["Covenant factory", "Launches coins on Covenant, for anyone.", at("0x42b9F24d88Ca015CC59E516B272F7A46a87Fa35a")],
      ["Basket list", "The coins in the basket: proposals, the 24-hour wait, vetoes.", at("0xD8cEA0015E2C876ab5fa6D9178b46B57d65c6087")],
      ["Basket vault", "Buys the basket near Ascend’s own average price, then pays it out.", at("0xE636003Feb05D0FB8f6016733C3d723446C9f221")],
      ["Staking", "Holds staked PNTH and streams the basket to stakers.", at("0x30c88fce1fAD545Df0fC603287f93F0f94076224")],
      ["HYPE Passport", "Records Passports that the Passport service signs.", at("0x0Eb4A8eB47364Be9d18410AF2f850db92b807290")],
      ["Swap helper", "Testnet only: lets the site buy PNTH from its Ascend pool.", at("0x31A67d054D34Ec18cb23A43B0E3ad1F756aA1500")],
      ["PNTH drip", "Testnet only: 10,000 free PNTH once per wallet, for when the pool is sold out.", at("0x49C7c3896bFc02Fe79EeBC13D8c8488Ec78e8624")],
    ],
    note: "The basket vault only buys within 5% of Ascend’s own average price, keeps each buy small, and skips a coin for a run after a big price move.",
  },
  faq: [
    {
      q: "Has it been audited?",
      a: "Not yet. It runs on testnet, and an audit comes before mainnet. Until then our contracts are verified on the explorer, every note from Slither (the standard automatic checker) is answered in our code repository, and the code goes public on GitHub before launch.",
    },
    {
      q: "Who holds the keys?",
      a: "We do, for now. The curator proposes basket lists. The guardian, a separate key, can veto a list or switch Passports off. We’d like Ascend to hold the guardian on mainnet. The Passport service signs Passports. None of these keys can move anyone’s funds.",
    },
    {
      q: "What could go wrong?",
      a: "A coin in the basket can lose value. Someone could try to push a price before the vault buys, which is why it only buys near Ascend’s average and keeps buys small. Passport tiers depend on our service reading Hyperliquid correctly.",
    },
    {
      q: "Found a problem?",
      a: "Message @pantheonindex on X and we’ll take it private. We’ve already reported one issue in Ascend itself to their team.",
    },
  ],
};
