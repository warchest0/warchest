# WARCHEST — Architecture decisions

> Settled on 2026-09-27 based on `RESEARCH.md`, by delegation from the project owner (recommendations from `PLAN.md`).
> Status: **ADOPTED** = we build on it · **PROVISIONAL** = we build on it, to be confirmed by a measurement · **OPEN** = blocked by a third party (legal, real money).

## D1 — Lots: LIFO — ADOPTED
A sale consumes the most recently acquired tokens first, in line with whitepaper §2.2. The technical plan said "FIFO": that is a typo.
A wallet → wallet transfer counts as a LIFO sale on the sender side and creates a new level-0 lot on the receiver side.

## D2 — Voting weight: merkle root per epoch — ADOPTED
- The indexer computes `weight(wallet) = Σ lot.amount × level(lot)`, with a level from 0 to 10.
- It builds a merkle tree `(epoch, wallet, weight)`, publishes the tree and the script, then pushes **only the root** via `submitWeightRoot`.
- The root becomes votable after a **challenge window** during which the guardian can revoke it.
- Each voter provides their proof. This eliminates double voting via transfer, since the weight is frozen at the snapshot.
- No per-wallet level is stored on-chain.

## D3 — Fee always taken in ETH — ADOPTED
- Native ETH = `currency0`, so `zeroForOne` = buy.
- If ETH is the specified currency, the fee is taken in `beforeSwap`; if it is unspecified, in `afterSwap`.
- The fee is 10%, sent to an immutable vault.
- No fee on adding or removing liquidity, nor on `transfer`.

## D4 — Custody of Hyperliquid funds: native HL multisig + sub-account + agent — ADOPTED (phase 1)
- Master account converted via `convertToMultiSigUser` (threshold ≥ 2/3).
- Trading happens in a sub-account, via a named agent with expiry ≤ 30 days and rotation.
- **No builder fee is approved.**
- The return of funds is signed by the multisig, never by the keeper.
- The option of an account held by an HyperEVM contract via CoreWriter is deferred to phase 2.

## D5 — Bridge route — PROVISIONAL
Outbound:
1. The vault swaps ETH → USDG on Robinhood Chain.
2. Across `4663 USDG → 999 USDC`, with recipient = HL account address (immutable in the vault).
3. HyperEVM → HyperCore transfer to the system address.

Return: `withdraw3` or Across `999 → 4663`, split according to `/limits`.

To be confirmed by S0.3 (small real transfer on mainnet, pending the owner's approval and funds).

## D6 — Testnet E2E with simulated bridge — ADOPTED
Across exists on neither the Robinhood testnet nor the Hyperliquid testnet. The E2E plan is therefore:
- On the Robinhood testnet: the official v4 (same addresses as mainnet) and a `MockAcrossSpokePool`.
- On the Hyperliquid testnet: real trading.
- Then on mainnet: small amounts, then treasury-sized amounts, before any real treasury.

## D7 — Profit distribution — OPEN (legal)
- The `WarchestDistributor` (cumulative merkle, Morpho URD pattern) is built as a **separate module disabled by default**.
- The buyback & burn alternative remains possible without touching governance or the vault.
- The final decision awaits legal advice.

## D8 — Quorum fallback — ADOPTED
- If quorum is not reached, the previous **direction** and **asset** remain the current decision.
- A position closed by stop-loss **is never reopened automatically**: a new decision that reached quorum is required.
- If there is no previous decision, nothing is done.

## D9 — Guardian multisig — ADOPTED
The guardian can:
- pause the vault and the keeper;
- revoke a weight root during its challenge window;
- revoke a keeper report during its window.

It **can never** move funds or change the bridge recipient.
