# App (frontend dapp)

Static Next.js dapp for holders: levels per lot, level-weighted votes, treasury transparency and a leaderboard. No
backend of its own: it reads the contracts over JSON-RPC and the weight tree JSON published by the indexer.

Stack: Next.js 16 (App Router, static export), TypeScript strict, Tailwind CSS 4, wagmi 2 + viem, TanStack Query,
Recharts, Vitest. Node ≥ 24.

```bash
cd app
npm ci
npm run dev        # http://localhost:3000
npm run typecheck
npm run lint
npm test           # pure logic: levels, LIFO simulator, option encoding, proof lookup, lot reconstruction
npm run build      # static export in out/
```

## Pages
| Route | What it shows |
|---|---|
| `/` | Landing: hero, how it works (fee → treasury → vote → trade → rewards), level mechanic, transparency, FAQ with risks |
| `/dashboard` | Level ring per lot, next-level countdown, voting multiplier, LIFO sell simulator, claimable rewards |
| `/vote` | Live round (asset × Long/Short bars, quorum, time left), cast vote with merkle proof, past rounds |
| `/treasury` | NAV, open position and risk parameters, `mustClose`, cumulative PnL vs high-water mark, vault events |
| `/leaderboard` | Holders by weight from the published tree, shareable rank card (1200×630 SVG, PNG export) |

## Demo mode
With `NEXT_PUBLIC_GOVERNANCE` or `NEXT_PUBLIC_VAULT` unset (the default, nothing is deployed yet), every hook is fed by
`src/data/mock.ts`: a deterministic, internally consistent world anchored to the current time. Every screen shows a
"Demo data" badge. Votes and claims are simulated and never send a transaction. Add `?preview=1` to open the dashboard
with a demo wallet.

## Configuration
Copy `.env.example` to `.env.local`. All variables are `NEXT_PUBLIC_*` (inlined at build time):
`NEXT_PUBLIC_CHAIN_ID` (4663 mainnet, 46630 testnet), `NEXT_PUBLIC_GOVERNANCE`, `NEXT_PUBLIC_VAULT`,
`NEXT_PUBLIC_TOKEN`, `NEXT_PUBLIC_DISTRIBUTOR`, `NEXT_PUBLIC_INDEXER_API` (optional indexer HTTP API),
`NEXT_PUBLIC_TREE_URL_TEMPLATE` (`{epoch}` is replaced by the round's snapshot epoch; defaults to
`$NEXT_PUBLIC_INDEXER_API/trees/{epoch}`), `NEXT_PUBLIC_DISTRIBUTION_TREE_URL`, `NEXT_PUBLIC_START_BLOCK`, `NEXT_PUBLIC_LOG_CHUNK`.

## Rebranding
The name, ticker, tagline and colors are not final. They live in **`src/config/brand.ts` only**; colors are injected as
CSS variables and mapped to Tailwind tokens in `globals.css`. `src/app/icon.svg` is a placeholder mark.

## How it works
- `src/data/types.ts` defines one `DataProvider` interface; `mock.ts` (demo) and `onchain.ts` (viem reads + tree
  fetch) implement it, and `hooks/queries.ts` wraps it in TanStack Query. Pages never know which one is active.
- Voting: the app downloads the tree for the round's epoch, checks that its root equals `weightRoot(epoch).root`
  on-chain, finds the leaf `(chainid, governance, epoch, account, weight)`, verifies the proof locally, then calls
  `vote(roundId, assetIndex*2 + side, weight, proof)`.
- With `NEXT_PUBLIC_INDEXER_API`, proofs come from `GET /proof/:epoch/:account` and lots from
  `GET /account/:account`; the proof is still verified against the on-chain root, and the API's lots are used only
  when its balance matches `balanceOf` on-chain.
- Lots (without the API, or when it lags): rebuilt client-side from the current balance and the last 10 days of `Transfer` logs (older tokens are at the
  max level whatever their exact age), with the same LIFO rules as the indexer.
- Event history (vault activity, PnL chart) is read with bounded backward `eth_getLogs` scans. A subgraph can replace
  it later behind the same provider.
- ABIs are minimal hand-copied subsets in `src/abi/index.ts`; Foundry artifacts are never imported.

## Known limitations
- Injected wallets only (EIP-6963); WalletConnect needs a project id and is not wired yet.
- Past round outcomes are derived from tallies (`finalize` timing is not re-checked).
- Leaderboard levels are not published by the indexer: only weights are shown for other holders.
