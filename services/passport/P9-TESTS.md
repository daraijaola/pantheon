# HYPE Passport: two tests for Micheal

Ayinde needs these done to finish the Passport launch (ticket P9). He can't do them himself: they need a
wallet that holds **real HYPE on Hyperliquid**, and he has none. About 5 minutes each.

## Before you start
- **MetaMask** in Chrome. The site offers to add the Elysium testnet network; say yes.
- **Your Hyperliquid wallet** in that MetaMask, holding HYPE: at least **10 staked or 20 held**. Staked HYPE
  counts in full, HYPE you just hold counts half.
- A **signature** is your wallet proving it's you. It's free and nothing is sent.
- If you click **Connect wallet** and nothing pops up, click the **MetaMask fox** at the top right of Chrome:
  the request is waiting there. (If you see red "[object Object]", that's the same thing.)

## Test 1: get a Passport
Shows the whole thing works for a real holder.

1. Open **https://pantheonindex.com/passport/get**
2. Click **Connect wallet**, choose **MetaMask**, and pick your Hyperliquid wallet.
3. Click **"It's this same wallet"**, or paste your Hyperliquid address if it's a different wallet.
4. Click **Check my HYPE**, then **Sign** (and Sign in MetaMask), then **Issue**.
5. You should see **"Your Passport is issued"** with a tier. We pay the fee for this step.
6. **Send Ayinde:** your wallet address and a screenshot.

## Test 3: unlink, then try again
Shows that one Hyperliquid wallet can't be moved from account to account to farm boosts: after an unlink
it must wait 7 days.

> ⚠️ **Only with a second Hyperliquid wallet.** The wallet you use here can't get a Passport again for
> 7 days. Don't use the one you need for the demo. No second wallet? Skip this test and tell Ayinde.

You also need a little **testnet HYPE** in that wallet (free, fake money:
https://elysium.kinetiq.xyz/testnet-faucet), because unlinking is a small transaction you send yourself.

1. Get a Passport with the second wallet (Test 1, steps 1–5).
2. Click **Unlink**, then **"Yes, unlink (your boost ends)"**, and confirm in MetaMask.
3. Do Test 1 again with the same wallet.
4. You should see **"That Hyperliquid wallet was unlinked recently. It can link again 7 days after."**
5. **Send Ayinde:** the wallet address and a screenshot.

## What Ayinde checks afterwards
From the server, he checks that the site and the chain agree on your Passport, and that your Hyperliquid
address and balance never went on-chain (only your tier and a private code do).
