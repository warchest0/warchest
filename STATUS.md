# WARCHEST — Progress status (2026-09-27)

Repository: github.com/warchest0/warchest (history migrated from the previous repository on 2026-09-27; all commits rewritten under the warchest0 account; PR numbers #1–#28 referenced below belong to the previous repository).

All the code is on **`staging`**. Nothing has been pushed to `main` (production).

Flow: `feat/*` → PR → `staging` → (later) `main`. Every PR was merged only with green CI, with one exception: #9, fixed by #10.

## Summary
| Branch (plan) | Slices | PR |
|---|---|---|
| Research (S0) | S0.1 measured gas, S0.4 errata, ETH→USDG liquidity | #1–#3, #5 |
| 1 `feat/token-hook` | S1.1–S1.5 | #4, #6, #7, #8 |
| 2 `feat/governance-levels` | S2.1–S2.3 + hardening (adversarial review) | #9–#13 |
| 3 `feat/treasury-vault` | S3.1–S3.5 + hardening (adversarial review) | #14–#18, #27 |
| 4 `feat/indexer` | S4.1–S4.4 | #19–#22 |
| 5 `feat/keeper-hyperliquid` | S5.1–S5.4 | #23–#26 |

**Total: 438 green tests.** They break down into 300 for the contracts (including the mainnet and testnet forks), 25 for the indexer and 113 for the keeper.

## Security reviews
- Two **adversarial reviews** (governance, then vault and distributor); every finding fixed with a regression test.

## Verified for real
- Gas measured on a fork of mainnet 4663: hook overhead ≈ 45k gas, i.e. ≈ $0.003 (RESEARCH §4).
- Uniswap v4 is present on testnet 46630 at the **same addresses** as on mainnet, with identical bytecode.
- **Full on-chain cycle** on a mainnet fork (`SystemCycleFork`):
  1. 20 ETH trade, generating 2 ETH of fee;
  2. TWAP conversion into ≈ 5,394 USDG;
  3. vote and decision;
  4. **real Across deposit**;
  5. D8 fallback;
  6. close, PnL, then claim via the distributor.
- The indexer's merkle proofs are accepted by the real governance, deployed on anvil.
- **Byte-correct** Hyperliquid signing: 14 vectors from the official SDK reproduced, plus a proof on testnet (recovered address). The agent **cannot build a withdrawal action**: an allowlist in the code rejects 45 action types.

## What is waiting on the project owner (blocked without you)
1. **S0.2**: a **funded** Hyperliquid testnet account (the faucet requires a prior deposit on mainnet), to obtain the raw proofs that an agent cannot do `withdraw3`, `vaultTransfer` or `subAccountTransfer`.
2. **S0.3**: a small real Across transfer, RH USDG → HyperEVM → HyperCore, then the return. This is real money.
3. Set up the Hyperliquid account: `convertToMultiSigUser`, a sub-account, then `approveAgent` (expiry ≤ 30 d).
4. A deployment key funded with testnet ETH, for `DeploySystem` on 46630, followed by 48 h of keeper dry-run. The monitor must run on a separate machine.
5. **Product or legal decisions:**
   - **D7**: distribute profits or do buyback & burn. Legal advice is needed **before** the mainnet deployment, because the distributor address is immutable in the vault.
   - **M3**: whether or not to add an exit or migration path for the vault. Today none exists, by design: the vault can never send anything elsewhere (VAULT.md §10).
   - **Take-profit**: `takeProfitBps` is expressed in bps of capital. A choice is needed between a trigger order on Hyperliquid and a close vote (`TAKE_PROFIT_TRIGGER`, see keeper/RUNBOOK.md).
6. **External audit** (S6.2): the drafts are in `contracts/docs/AUDIT-REQUEST.md` (UF Security Fund) and `HOOKLIST.md`. Nothing has been submitted.
7. **CI/CD pipelines** for staging and prod, to be done together as planned.
8. Recommended: enable branch protection on `staging`, to require green CI before any merge.

## Main residual risks
- **Colluding counterparty** on Hyperliquid: a compromised agent can lose money by trading against an accomplice. The keeper cannot prevent this. Mitigations in place: closed asset list, independent monitor, kill switch.
- **Bridged USDC lands on HyperEVM**, under the Hyperliquid account's single EVM key, before moving to HyperCore under the multisig (RESEARCH §2.4).
- Governance and distributor: the guardian can **block**, but not choose. Updater rotations are delayed: ≥ 72 h for governance, ≥ 4 d for the distributor.
- **Legal**: the scheme is very close to an investment contract (Howey) or a fund within the meaning of EU regulation (RESEARCH §6).

## Added on 2026-09-29 (repository warchest0/warchest)
| PR | What |
|---|---|
| #8 | Indexer HTTP API for the frontend (`/proof`, `/leaderboard`, `/account`, `/trees`, `/epochs`); fork tests made robust to live chain state; `ExtendOracleHistory` script (the WETH/USDG pool's oracle history shrank from ≈ 44 h to ≈ 11 h as activity grew; the vault needs 6 h) |
| #9 | Frontend dapp MVP (`app/`): landing, dashboard (level rings, ×N vote weight, LIFO sell simulator, rewards), live vote, treasury transparency, leaderboard + rank card; demo mode until contracts are deployed; brand in one config file |
| #10 | One-command testnet deployment (`DeployTestnet.s.sol`) with testnet stand-ins for WETH, USDG, the oracle pool and Across; full cycle verified on a testnet fork |
| #11 | Docker images and compose profiles for the indexer (publisher, API, independent verifier) and the keeper (loop, independent monitor) |
| #12 | Promotion of `staging` to `main` |

Next steps that only need a funded testnet key: run `DeployTestnet`, start the indexer and keeper (dry-run) with `deploy/docker-compose.yml`, and point the frontend at `contracts/deployments/46630.json`.
