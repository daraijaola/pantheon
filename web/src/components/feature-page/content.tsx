// What each feature page says. Facts come from the specs (docs/PASSPORT_SPEC.md and the
// blueprint): tiers, boosts, vote weights, the 24-hour wait, the 20% cap. Plain words only.

import { BallotCard, CovenantCard, PassportCard } from "./cards";
import type { Feature } from "./feature-page";

const X = "https://x.com/pantheonindex";

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
    { label: "See the tiers", href: "#details", primary: true },
    { label: "Follow for launch", href: X },
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
      Ten coins.
      <br />
      <span>Earned, not bought.</span>
    </>
  ),
  sub: "Seven coins make the basket on their numbers. Three more are voted in each week by HYPE Passport holders. Ascend can veto any pick.",
  actions: [
    { label: "Read the rules", href: "#details", primary: true },
    { label: "See the basket", href: "/#basket" },
  ],
  diagram: <BallotCard />,
  steps: [
    {
      title: "Scored in the open",
      desc: "Every Ascend coin is scored on a week of real trading. Fake volume and bundled buys don’t count, and anyone can check the math.",
    },
    {
      title: "Three seats, one vote",
      desc: "Each week Passport holders vote three more coins in. A vote is a free signature, and higher tiers carry more votes.",
    },
    { title: "A day to say no", desc: "Every change waits 24 hours before it happens. In that time, Ascend can veto any coin." },
  ],
  details: {
    title: "The rules every coin must pass",
    sub: "They are the same for every coin, with no exceptions.",
    head: ["Rule", "What it means"],
    rows: [
      ["Age", "A coin must be at least 3 days old."],
      ["Market", "It must trade against USDC on Ascend."],
      ["Size", "No coin can be more than 20% of the basket."],
      ["Votes", "One Passport, counted by its tier: 1, 2 or 3 votes."],
      ["Changes", "Every change waits 24 hours, and Ascend can veto it."],
    ],
  },
  faq: [
    { q: "Can a coin pay to get in?", a: "No. Paying PANTHEON gives a coin no advantage in the score or the vote." },
    { q: "Who can vote?", a: "Anyone with a HYPE Passport that was linked before the vote opened." },
    {
      q: "How is a coin scored?",
      a: "On a week of its trading, using the middle of the week rather than its best day, with wash trades and bundled buys filtered out.",
    },
    { q: "Why can Ascend veto?", a: "As a safety check against scams slipping in. Ascend can only stop a pick. It can’t add one." },
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
  sub: "Covenant is the contract that collects PANTHEON’s share of every trade fee and does exactly what it was told at launch. No one can change it, including us.",
  actions: [
    { label: "Read the rules", href: "#details", primary: true },
    { label: "See where fees go", href: "/#how-it-works" },
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
    sub: "PNTH is the first coin on Covenant. Other creators will be able to give their own fees a job that can’t be undone.",
    head: ["Job", "What the fees do"],
    rows: [
      ["Burn", "Burn the coin’s own supply."],
      ["Buy wall", "Keep buying the coin below the market price."],
      ["Vesting", "Pay a team slowly, on a fixed schedule."],
      ["Holders", "Stream rewards to people who hold the coin."],
      ["Pantheon", "Send a share to the PANTHEON basket."],
    ],
    note: "Jobs for other coins open after PNTH launches.",
  },
  faq: [
    { q: "Can the PANTHEON team take the fees?", a: "No. The fees go to the contract, and the contract can only do the jobs it was given." },
    {
      q: "What if something needs fixing?",
      a: "It can’t be upgraded, so it is kept small and simple, and its code is public for anyone to review before launch.",
    },
    { q: "Where can I see it?", a: "The contract address will be listed here at launch, with a link to every buy and burn it makes." },
  ],
};
