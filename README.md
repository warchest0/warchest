# WARCHEST

A token on Robinhood Chain where every trade feeds a shared treasury, and every holder's influence over that treasury grows the longer they hold.

- **10% trading fee**, collected by a Uniswap v4 hook at swap time (never on plain transfers) and sent to the treasury.
- **Holder levels 1–10**: each day held raises a lot's level; selling only resets the portion sold (LIFO).
- **Level-weighted governance**: voting weight = Σ lot × level. Holders vote on which asset and direction the treasury trades.
- **Treasury trading on Hyperliquid**, executed by a keeper whose agent wallet can trade but can never withdraw. Hard cap of 20% of the treasury per trade.

## Repository layout
| Path | What it is |
|---|---|
| `contracts/` | Solidity (Foundry): `WarchestToken`, `WarchestHook`, `WarchestGovernance`, `WarchestVault`, `WarchestDistributor`, deployment scripts, tests |
| `indexer/` | TypeScript service: indexes transfers, computes LIFO lots and levels, publishes the daily weight merkle root |
| `keeper/` | TypeScript bot: executes governance decisions on Hyperliquid through the vault and the Across bridge |
| `web/` | Responsive public website, animated globes, governance simulator and protocol documentation (pre-launch preview) |
| `research/spikes/` | Throwaway gas-measurement spike |
| `RESEARCH.md` | Verified research: Robinhood Chain, Uniswap v4, Hyperliquid, Across, gas, legal |
| `DECISIONS.md` | Architecture decisions D1–D9 |
| `PLAN.md` | Build plan by slices |
| `STATUS.md` | Current progress and what remains |

## Quick start
```bash
git submodule update --init --recursive
cd contracts && forge test           # Solidity
cd ../indexer && npm ci && npm test  # indexer
cd ../keeper && npm ci && npm test   # keeper
```

## Website preview

```bash
cd web
npm run dev  # http://localhost:4173 — no dependencies to install
```

`npm run check` validates the website code and calculator; `npm run build` produces the static site in `web/dist/`.
The combined Vercel deployment serves the website at `/` and the demo dApp at `/dashboard/`, `/vote/`, `/treasury/`, and `/leaderboard/`. GitHub Actions validates both frontends and deploys the same tested artifact after all CI checks pass. See `deploy/FRONTEND.md` for staging/production setup.

## Workflow
Work branches → pull request into `staging` (test environment) → `staging` is promoted to `main` (production).

`scripts/ship.sh <branch> "<commit message>" [--promote]` runs the whole flow: commit, push, PR into `staging`, merge, and optionally promote `staging` to `main`. It always acts as the repository owner account (`gh auth token --user <owner>`), whatever account is active in `gh`.

## Status
Code complete for the MVP and tested on forks of Robinhood Chain mainnet. Not yet deployed, not yet externally audited. See `STATUS.md`.
