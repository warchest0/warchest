# WarchestDistributor (S3.4) — optional module (D7)

> **Pending legal decision (D7).** The vault receives the distributor address in its constructor, as an **immutable**.
> - With `address(0)`, distribution is **permanently disabled** for this deployment.
> - To enable it, the distributor must be deployed **before** the vault, then `dist.setVault(vault)` must be called.

## Flow
1. `fund()` (permissionless) pulls `vault.distributable()`, i.e. the realized profit above the high-water mark, when no position is open. The amount is **measured** via balance change, not declared.
2. The indexer allocates each funding according to the snapshot weights (Σ lot × level) and publishes a tree of **cumulative entitlements** `(account, cumulativeAmount)`, with leaves domain-separated by `chainid` and contract address.
3. `proposeRoot(root, totalCumulative, treeHash)`: the root is pending for `timelock`, and the guardian can revoke it. **A pending root cannot be replaced by the updater.** This is the fix for the Morpho URD flaw, where a compromised updater restarts the delay indefinitely.
4. `acceptRoot()` is permissionless once the delay has elapsed.
5. `claim(account, cumulative, proof)` pays `cumulative − claimed[account]` to the account. Anyone can trigger the payout.

## Safety bounds
- `totalCumulative ≤ totalFunded`, and never decreases.
- `totalClaimed ≤ totalCumulative` of the active root. An under-declared tree can therefore only block the last claimers, never release more than intended.
- The guardian can **never** move funds. Its only powers are `setVault` (once), `proposeUpdater` / `cancelUpdaterChange`, `revokePendingRoot` and the two-step transfer of its role.

## Updater rotation (security review, high finding, fixed)
Before: `setUpdater` was instantaneous. The guardian alone could appoint itself updater, propose a root paying itself all the funded profit, and nobody but itself could revoke that root: after the timelock, `acceptRoot` and `claim` were permissionless. A direct violation of D9 ("the guardian never moves funds").

Now, modeled on `WarchestGovernance`:
- `proposeUpdater(next)` (guardian) emits `UpdaterChangeProposed(next, readyAt)` with `readyAt = now + updaterDelay`, where **`updaterDelay = timelock + 3 days`** (immutable, 4 days with the recommended 1-day timelock).
- `cancelUpdaterChange()` (guardian) cancels; `applyUpdaterChange()` is **permissionless** once `readyAt` is reached. The old updater keeps its role throughout the notice period.
- A root proposed by the new updater still waits for its own `timelock`.

Residual trust, documented: after this public notice of ≥ 4 days, followed by the root timelock, the guardian + updater pair can still misallocate **already funded** profit (never the principal, the vault only releases `distributable()`). The fastest attack is therefore announced on-chain for `updaterDelay + timelock ≥ 5 days` (`UpdaterChangeProposed`, `UpdaterChanged`, `RootProposed` with `treeHash`), which the independent verifier detects and which leaves time to challenge the multisig. No additional on-chain bound was retained: a per-account or per-root cap is not sound (the guardian can split across addresses it controls, and a legitimate allocation can concentrate entitlements on a large holder).

## Tests
`test/WarchestDistributor.t.sol`: 15 tests wired to the **real** `WarchestVault`, plus `test_regression_distributorGuardianCannotStealFundedProfit` in `WarchestVaultReviewRegression.t.sol`. Covered:
- profit, loss, HWM;
- timelock and revocation;
- inability to restart the delay;
- cumulative claims over two cycles;
- forged proofs;
- under-declared tree;
- guardian with no power over funds or roots;
- updater rotation: delay, cancellation, permissionless application, events, theft PoC replayed.
