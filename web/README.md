# Network selection

`NEXT_PUBLIC_DEPLOYMENT` selects `elysium-testnet` (default), `elysium-mainnet`, or the existing `local` development fork. The canonical network and contract data lives in the root `deployments/elysium-*.json` manifests. Mainnet's unknown fields intentionally remain `null`: both build and startup reject incomplete profiles with one list of missing fields. There is no fallback to testnet. Public configuration is frozen into the browser build; rebuild when changing network.

The network block supplies chain metadata, public RPC, explorer, deployment start, external addresses and mainnet `acquireUrl`. The web does not directly address Kalos/PerpMe contracts: those addresses remain backend concerns for phase 2. `network.external.whype` records Kalos WHYPE; PerpMe and HyperEVM WHYPE are distinct assets, not interchangeable addresses.

Keep private provider endpoints in server-only `ELYSIUM_RPC`, used by SIWE signature verification and public Passport reads. The documented Alchemy mainnet URL shape is `https://elysium-mainnet.g.alchemy.com/v2/{KEY}`; never put a real key in a manifest or `NEXT_PUBLIC_*`. Alchemy URLs are rejected as manifest public RPCs. The existing `NEXT_PUBLIC_RPC_URL` override is retained for testnet/local fixtures only; mainnet always uses its manifest public RPC.

Mainnet `/get` links to the required `network.acquireUrl`; the faucet, mock-USDC mint and PNTH drip are testnet-only. Sessions and nonces are bound to the selected chain; older cookies without a chain ID require signing in again. Backend/deploy-script migration is separate and is not performed by selecting the web profile.

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
