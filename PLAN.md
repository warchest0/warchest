# WARCHEST — Build plan in slices

> Based on `RESEARCH.md` (2026-09-27). The branch order strictly follows `instructions`: token-hook → governance → vault → indexer → keeper.
> One slice = one deliverable, tested PR. **Risk** column: 🟢 standard · 🔴 **security-critical** (a mistake costs real money or creates a security hole: extra review required).

---

## Decisions (settled → see `DECISIONS.md`)

| # | Decision | Recommendation |
|---|---|---|
| D1 | FIFO or LIFO for lots? | **LIFO**, as in the whitepaper: the most recent tokens are sold first. |
| D2 | How does governance receive the weights? | A **merkle root of weights per epoch** + a challenge window, instead of per-wallet level writes. |
| D3 | In which currency is the fee taken? | **Always in ETH.** |
| D4 | Who holds the funds on Hyperliquid? | Phase 1: **native HL multisig** + sub-account + agent. The HyperEVM contract account (CoreWriter) is to be studied later. |
| D5 | Which bridge route? | Path A (RH USDG → HyperEVM → HyperCore) or path B (via Arbitrum): **settled by spike S0.3**. |
| D6 | How to do the E2E on testnet without an Across testnet? | **Simulated** bridge on testnet, then mainnet validation with small amounts, then treasury-sized amounts. This relaxes the "testnet E2E" constraint: your call. |
| D7 | What to do with profits? | Merkle distribution (legal risk) or buyback & burn. **Legal advice first.** |
| D8 | What happens if quorum is not reached? | Keep the previous *direction*, but **never automatically reopen** a stopped-out position. |
| D9 | Who can pause the system? | A **guardian multisig** able to pause the vault and the keeper. It can never move funds. |

---

## Slice 0 — Measured research (branch `research/spikes`, throwaway code, outside prod)
Goal: close all the [TO MEASURE]/[TO TEST] items in RESEARCH.md. **No prod code until S0 is finished.**

| Slice | Content | Deliverable | Risk |
|---|---|---|---|
| S0.1 | Foundry on a mainnet 4663 fork with a minimal fee hook (spike). Gas for the 4 swap cases, the root push, a vote with proof and a worst-case on-chain LIFO. | Table §4 of RESEARCH.md filled in | 🟢 |
| S0.2 | Script on the HL testnet: an agent attempts `withdraw3`, `usdSend`, `vaultTransfer`, `subAccountTransfer` and `approveAgent`. The raw rejections are logged. | §2.2 closed, with evidence | 🔴 (security conclusion) |
| S0.3 | Real transfer on mainnet, small amounts (~$50–100), RH USDG → HyperEVM → HyperCore **and** via Arbitrum, then back. Measure delay, cost, manual steps. Also measure ETH→USDG liquidity on RH. | D5 settled | 🟢 (with your OK: this is real money) |
| S0.4 | Whitepaper update: Stakd, LIFO, stop-loss on HL, USDG bridge. | Doc PR | 🟢 |

---

## Branch 1 — `feat/token-hook`
| Slice | Content | Done criterion | Risk |
|---|---|---|---|
| S1.1 | Foundry scaffold + CI (fmt, test, slither) + `WarchestToken.sol`: pure OZ ERC20, fixed supply, **no** fee logic. | Tests: a transfer costs nothing, no hook in the token | 🟢 |
| S1.2 | `WarchestHook.sol` (OZ `BaseHook`), **exactIn** buy/sell case: 10% in ETH, `take` to an immutable vault, `beforeInitialize` that only allows the TOKEN/ETH pool. Deployment script with HookMiner. | Tests on a mainnet fork, real PoolManager | 🔴 |
| S1.3 | **exactOut** case, partial swaps (`sqrtPriceLimit`), zero liquidity, tick crossing, fuzzing and invariants (fee = 10% ± 1 wei, never an unsettled delta), add/remove liquidity untaxed. | Green invariant suite | 🔴 |
| S1.4 | Testnet 46630 deployment: v4-core deployed by us + token + hook + pool. Blockscout verification. Uniswap hooklist submission. | Real swap on testnet, gas-report | 🟢 |
| S1.5 | Pre-audit: request to the UF Security Fund, code freeze. | Submission sent | 🟢 |

## Branch 2 — `feat/governance-levels` (mocked vault, zero dependencies)
| Slice | Content | Done criterion | Risk |
|---|---|---|---|
| S2.1 | Epochs + `submitWeightRoot(epoch, root)` by the updater, challenge window, revocation by the guardian. | Role and timing tests | 🟢 |
| S2.2 | Proposals with a closed list of assets × direction. `vote(epoch, choice, weight, proof)`, one vote per wallet per epoch, tally, quorum. | Merkle tests + double-vote attempt | 🟢 |
| S2.3 | Quorum fallback (D8), close vote above the profit threshold, decision exposed to the vault (`IWarchestDecision`) + MockVault. | 100% branch coverage, invariants | 🟢 (extra review advised on S2.2–S2.3) |

## Branch 3 — `feat/treasury-vault` (mocked keeper)
| Slice | Content | Done criterion | Risk |
|---|---|---|---|
| S3.1 | Receiving ETH from the hook, ETH→USDG swap with bounded slippage, local NAV accounting. | Fork tests | 🟢 |
| S3.2 | `executeOrder()`: reads the governance decision, **hard 20% cap**, cooldown, Across deposit with **immutable recipient**, limited keeper role. | Invariant: the vault can never send elsewhere nor more than 20% | 🔴 |
| S3.3 | Keeper reports (open, close, PnL) with delay and dispute, published stop-loss parameters (enforced on HL), high-water mark, pause by the guardian. | Tests with MockKeeper, including a malicious keeper | 🔴 |
| S3.4 | Separate `WarchestDistributor.sol`: Morpho URD-style cumulative merkle, funded only above the HWM. **Depends on D7.** | Claim tests | 🟢 |
| S3.5 | Governance ↔ vault wiring on testnet. | Vote → order cycle with mocked keeper | 🟢 |

## Branch 4 — `feat/indexer` (TypeScript or Python)
| Slice | Content | Done criterion | Risk |
|---|---|---|---|
| S4.1 | Ingestion of `Transfer` events (RPC/Blockscout), handling of reorgs and finality, 100 ms blocks. | Replays the whole testnet history deterministically | 🟢 |
| S4.2 | **LIFO** lot model, daily snapshot, levels 1–10 per lot, exclusions (PoolManager, vault, contracts). | Unit tests on whitepaper scenarios | 🟢 |
| S4.3 | Deterministic merkle tree, publication of the tree and the script, root push, 2nd independent verification instance. | Two runs give the same root | 🟢 |
| S4.4 | Scale test with 10k / 100k synthetic holders, push cost, alerting. | Figures added to RESEARCH.md | 🟢 |

## Branch 5 — `feat/keeper-hyperliquid` (last, maximum risk)
| Slice | Content | Done criterion | Risk |
|---|---|---|---|
| S5.1 | Read-only mode: reads governance, the vault, the HL account and the Across limits. Dry-run that logs the planned actions. | Runs 48 h without errors | 🟢 |
| S5.2 | Trading on the HL testnet via the agent: isolated margin, fixed leverage, TP/SL placed **after** the fill, `scheduleCancel`, agent rotation, independent monitor (leverage, allowed assets). | Open/close + stop triggered on testnet | 🔴 |
| S5.3 | Bridge module: Across deposits, tracking, retry, splitting beyond `/limits`, fillDeadline. Simulated on testnet. | Tests + small-amount mainnet transfers | 🔴 |
| S5.4 | Return of funds (signed by the multisig, D4), report to the vault, kill switch, alerts. | Incident runbook written | 🔴 |
| S5.5 | **E2E**: vote → quorum → vault order → bridge → HL position → close → return → distribution. On testnet with a simulated bridge, then on mainnet with a tiny treasury cap. | Checklist §7 of RESEARCH.md fully green | 🔴 |

## End
| Slice | Content | Risk |
|---|---|---|
| S6.1 | Full pre-audit security review (all contracts + keeper) | 🔴 |
| S6.2 | External audit + fixes | 🔴 |
| S6.3 | Mainnet, low treasury cap, monitoring | 🟢 |

---

## Security-critical slices (summary)
These slices get an extra adversarial review before merge:
- **S0.2**: this is the security conclusion on the agent's permissions.
- **S1.2, S1.3**: hook delta accounting. A bug here steals or locks funds on every swap.
- **S3.2, S3.3**: vault fund flows and the trust granted to the keeper.
- **S5.2 to S5.5**: keeper, bridge and real capital.
- **S6.1**: global review before the audit.

Everything else (scaffold, governance, indexer, deployments, docs): standard review.

## Realistic schedule
| Week | Work |
|---|---|
| W1 | Decisions D1–D9 + S0 |
| W2–3 | Branch 1 (token + hook) → start of the hook audit request |
| W4–5 | Branch 2 (governance) |
| W5–7 | Branch 3 (vault) |
| W7–8 | Branch 4 (indexer) |
| W9–11 | Branch 5 (keeper) + E2E |
| W11–16 | Audit (4–8 weeks) in parallel with the fixes |
| ≈ W14–16 | Mainnet, low cap |

The legal advice (D7) is pursued **in parallel from week 1**.

## Git flow
`feat/*` → PR to `staging` (test environment) → merge. `staging` → `main` = production. CI/CD pipelines to be added later (staging and prod).

## Status
See `STATUS.md` (updated on 2026-09-27).
