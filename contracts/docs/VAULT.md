# WarchestVault — design notes and trust model

Contract `contracts/src/WarchestVault.sol`. It **holds the treasury**. It is separate from `WarchestGovernance`, which
holds nothing and only publishes decisions (`IWarchestDecisionSource`). No owner, no proxy, no function that sends ETH
or USDG to an arbitrary address: the only fund outflows are the conversion pool (S3.1), the Across SpokePool towards
an **immutable** recipient (S3.2) and, if an immutable distributor was set at deployment, realized profit above the
high-water mark (S3.3, disabled while D7 remains open).

## 1. Custody (S3.1)

- `receive()` accepts native ETH **from anyone, at any time, even while paused**, and never reverts: the hook's
  `flush()` and `WETH.withdraw()` depend on it. It emits `EthReceived`.
- No `fallback`: a call with unknown calldata reverts, which does not affect a plain transfer.

## 2. ETH → USDG conversion (S3.1)

### Venue
Uniswap **v3** 0.01% WETH/USDG pool `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` (TVL ≈ $19.6M, the deepest
measured in `RESEARCH.md` §3.3). Verified on-chain on 2026-09-27: `token0 = WETH 0x0Bd7…AD73`, `token1 = USDG
0x5fc5…d168` (6 decimals), `fee = 100`, factory `0x1f7d…2EfA` (the official v3 factory listed by Uniswap for
chain 4663).

The vault calls the pool **directly** (`swap` + `uniswapV3SwapCallback`) instead of going through the official
`SwapRouter02` `0xcaf681a66d020601342297493863e78c959e5cb2` (verified on-chain, `factory()` and `WETH9()` consistent):
one less trusted contract, no lingering token approval, and the callback only pays the pool what it requests
(`amount0Delta`), never more than the exact input. The callback is only accepted if `msg.sender == pool` **and**
a swap is in progress (transient flag), which prevents anyone from siphoning WETH the vault might hold.

The fork test `test_fork_convertOneEthMatchesQuoter` checks that the amount received is **identical** to the quote from
the official `QuoterV2` `0x33e8…a9E7` for the same block.

### On-chain safeguard against a compromised keeper
`convertEthToUsdg(amountIn, minOut)` is restricted to the `keeper`, but **a stolen keeper cannot dump the ETH**:

1. **TWAP floor**: `minOut ≥ twapFloor(amountIn) = quote(TWAP_{30 min}) × (1 − maxSlippageBps)`. The TWAP comes
   from `pool.observe([1800, 0])` (arithmetic mean tick, rounded towards −∞ like `OracleLibrary`). The pool has an
   observation cardinality of **10,809** (≈ 44 h of history at ~4 observations/min), verified on-chain; a
   24 h window answers without `OLD`. Should the history ever run short, `observe` reverts and the conversion is
   blocked (fail-closed), nothing is sold.
2. **Actual output checked**: the swap reverts if the USDG received is `< minOut` (measured by balance delta, not
   by the value returned by the pool) and if the pool did not consume exactly `amountIn` (`PartialFill`).
3. **Per-call cap** `maxConvertPerCall` and **cooldown** `convertCooldown`: the pace is bounded, the guardian
   has time to pause.
4. **One-way**: there is no USDG → ETH function. A malicious keeper therefore cannot round-trip to accumulate
   slippage.
5. **Oracle circuit breaker** (review M1): the conversion reverts (`OracleDeviation`) if the short TWAP (`twapWindow`)
   deviates from the long TWAP **`LONG_TWAP_WINDOW = 6 h`** (constant) by more than
   `maxTwapDeviationTicks = 2 × maxSlippageBps` ticks (1 tick ≈ 1 bp, i.e. 200 ticks ≈ 2%). A one-off dump moves
   neither TWAP (case 2). A dump **held** for `twapWindow` drags the short TWAP and therefore the floor along
   (measured on the real pool: floor 2,666 → 2,520 USDG/ETH after 31 min held, −5.5%), but not the 6 h TWAP: the
   vault refuses to sell as long as the deviation persists. Holding the price for 6 h against arbitrage on a
   $19.6M pool is the cost of the attack; at that point the price *is* the market. `oracleStable()` exposes the state.
   Symmetric: a short TWAP that is too **high** is rejected as well (the oracle is not reliable, we wait).

Proven maximum loss (fuzz `testFuzz_maliciousKeeper_cannotSellBelowFloor`, invariant `invariant_neverSoldBelowFloor`,
fork `test_fork_sandwichedSpotRejected`, `test_fork_heldDumpTripsOracleBreaker`): **`maxSlippageBps` of the ETH
converted**, relative to a 30 min TWAP that is itself bounded to ±2% of the 6 h TWAP.
Recommended values: `twapWindow = 30 min` (must be `< 6 h`, checked at deployment), `maxSlippageBps = 100`
(1%), `maxConvertPerCall = 50 ETH`, `convertCooldown = 10 min`.

**Keeper policy for `minOut`**: `minOut = max(twapFloor(amountIn), quote QuoterV2 × 0.999)`. The on-chain
floor is the guarantee against a *compromised* keeper; an *honest* keeper must demand the price it just
quoted (minus 0.1% tolerance), otherwise it leaves a sandwicher the entire spot − floor gap (up to 1%). If the
conversion reverts (`InsufficientOutput`, `OracleDeviation`, `ConvertCooldown`), the keeper retries later: nothing
is sold, it is fail-closed.

Known limitations:
- If the spot price deviates by more than `maxSlippageBps` **below** the TWAP (volatile market), conversions fail
  until the TWAP catches up: this is intended. Likewise if ETH moves by more than 2% between the 30 min TWAP and the
  6 h TWAP (in either direction): the circuit breaker delays the conversion by a few hours, it never blocks
  permanently (the fork tests "calm" the oracle with a 6 h `warp` when the real market is in this
  state at the fork block; the raw deviation is logged).
- If the spot is **above** the TWAP, the on-chain guarantee remains "never below TWAP × (1 − s)", not "at the
  best price": it is the `minOut` policy above that closes the gap.
- A pool without 6 h of oracle history (fresh testnet) blocks conversions (`OLD`, fail-closed).

## 3. NAV (S3.1)

`nav()` = **USDG balance + ETH balance × TWAP × (1 − maxSlippageBps)**, in USDG (6 decimals).

- ETH is valued at the **floor** a conversion is guaranteed to reach, never at spot: NAV is
  pessimistic by construction, and so is the 20% cap computed on it.
- Capital sent to Hyperliquid **is not** in `nav()`. Since an order can only be executed with no open
  position, the cap is always measured on the vault's **liquid** assets, never on a reported value.
- `usdgLedger` = USDG accounted for by the vault's operations (incoming conversions, outgoing orders).
  `balance − ledger` = USDG that arrived from outside (bridge returns, refund of an expired deposit, donations), which
  S3.3 attributes to the position being closed. An order can only use **accounted** USDG.

## 4. Order execution (S3.2)

`executeDecision(amount, outputAmount, quoteTimestamp, fillDeadline)`, keeper-only, not while paused:

| Check | Rule |
|---|---|
| Decision | `governance.currentDecision()`, `id ≠ 0`, **`id > lastExecutedDecisionId`** (each id at most once, D8) |
| Position | no open position (**only one at a time**) |
| Cooldown | `block.timestamp ≥ nextExecuteAt`: a close that came back **below its capital** blocks the next order for `reportChallengeWindow` (review L2, §5); a close at least at break-even blocks nothing |
| Freshness | `block.timestamp ≤ governance.getRound(roundId).endsAt + maxDecisionAge` (a stale decision must be re-voted: every quorate round mints a new id) |
| Cap | `0 < amount ≤ nav() × capBps / 10,000`, and `capBps ≤ MAX_CAP_BPS = 2,000` **checked at deployment** |
| Ledger | `amount ≤ usdgLedger` |
| Bridge fees | `amount × (1 − maxBridgeFeeBps) ≤ outputAmount ≤ amount` (USDG and USDC both have 6 decimals) |
| Deadline | `fillDeadline > now`; the SpokePool itself enforces `quoteTimestamp ∈ [now − 1 h, now]` and `fillDeadline ≤ now + 6 h` |

Then, in this order: `lastExecutedDecisionId = id`, position recorded (`decisionId, asset, side, capital,
openedAt, depositId`), `usdgLedger −= amount`, `forceApprove(spokePool, amount)`, **`deposit(bytes32,…)`** on the
SpokePool, check that the SpokePool pulled **exactly** `amount` and has no remaining allowance, event
`OrderExecuted(decisionId, asset, side, capital, outputAmount, depositId, stopLossBps, leverage, takeProfitBps)`.

### What is fixed in the Across deposit
- `depositor = vault`: an expired deposit (nobody fills it before `fillDeadline`) is **refunded to the vault** on
  Robinhood Chain; S3.3 sees it as a capital return.
- `recipient = bridgeRecipient` (Hyperliquid account, D4 multisig), `outputToken = USDC HyperEVM`,
  `destinationChainId = 999`: **immutable**, no setter.
- `exclusiveRelayer = 0`, `exclusivityParameter = 0` (no exclusive relayer, no re-org sensitivity),
  `message = ""` (the recipient is an EOA, nothing to execute).
- Step 3 of D5 (HyperEVM → HyperCore): performed by the multisig's HyperEVM key, outside the vault.

### Across ABI used
`deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount,
uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32
fillDeadline, uint32 exclusivityParameter, bytes message)` — the current (non-deprecated) version of
`across-protocol/contracts` `SpokePool.sol`. Verified on 2026-09-27: selector `0xad5425c6` present in the bytecode
of implementation `0x1771…edd8` behind proxy `0xD29C85F15DF544bA632C9E25829fd29d767d7978`, `depositQuoteTimeBuffer =
3,600`, `fillDeadlineBuffer = 21,600`, and **real deposit executed on a mainnet fork** (`test_fork_executeDecision_realSpokePool`,
`FundsDeposited` event matching field by field). `depositV3(address,…)` also exists but is marked
"backward compatibility". `enabledDepositRoutes` no longer exists in this version (routes are no longer guarded
on-chain).

### Published risk parameters
`stopLossBps`, `leverage`, `takeProfitBps` are immutable, exposed by `riskParams()` and emitted with each order. The
stop-loss **cannot** be enforced from Robinhood Chain (`RESEARCH.md` §2.5): the keeper must place the
trigger orders on Hyperliquid, and an independent monitor must verify that it did.

### `mustClose()`
True when a position is open and: governance voted to close (`isCloseRequested`, **without rechecking
the profit threshold**), **or** governance minted a more recent decision (position **superseded**, even if the
new decision has the same asset and the same side: we close then reopen, it is simpler and auditable), **or**
the guardian paused the vault. Until the position is closed (S3.3), no new decision can be
executed.

### Malicious keeper: worst case
Proven by `testFuzz_execute_boundsHold`, `test_maliciousKeeper_atMostCapOncePerDecision`, the invariant
`invariant_orderBounds` and the fork: whatever the `amount`, `outputAmount`, `quoteTimestamp`, `fillDeadline`,
a call either reverts **or** sends **≤ 20% of the liquid NAV**, **only once per governance decision**, to the
**SpokePool for the immutable recipient**, with **≤ `maxBridgeFeeBps`** in fees. It can neither change the
recipient, nor execute twice, nor open a second position, nor dump the ETH (§2). Its remaining leverage is
**timing** (executing at the worst market moment) and what it does *on Hyperliquid* with the agent (see
`RESEARCH.md` §2.3), out of the vault's reach.

## 5. Reports, close, PnL, high-water mark (S3.3)

### Equity reports with a challenge window
- `reportPosition(decisionId, equityUsd)` (keeper, not while paused): mark-to-market value of the Hyperliquid account for the
  open position. The report **only counts after `reportChallengeWindow`** (6 h recommended); during this
  window the guardian can revoke it (`revokeReport`). **A pending report cannot be replaced**
  (`ReportPending`, review L1): otherwise the keeper could re-report every < 6 h and forever prevent a
  report from maturing, and therefore any take-profit vote. A new report is only accepted after maturity or revocation;
  an already matured report is kept as the "final" report until a more recent one matures.
  `finalizedEquity(decisionId)` returns the equity that counts (and whether it exists). Consequence for the keeper: at most one
  report every 6 h, and a false value can only be corrected through revocation by the guardian.
- A report is **purely informational**: it never moves funds and changes no balance. Its only
  effect is to allow a close vote.
- `closeVoteAllowed(decisionId)` (read by `WarchestGovernance.startCloseRound`, never reverts) = position open
  for this id **and** not being closed **and** `!mustClose()` (not superseded, not already voted, not paused)
  **and** finalized equity `≥ capital × (1 + takeProfitBps)`.

### Close: the keeper declares, the chain measures
- Once `mustClose()` is true (close voted — **unconditional, without rechecking the threshold** —, decision
  superseded, or pause), the keeper closes on Hyperliquid, the multisig signs the return (D4, never the keeper), and the
  keeper calls `reportClosed(decisionId)` (allowed **even while paused**: bringing funds back is always
  desirable).
- **Minimum age** (review L2): without a governance reason (`mustClose()` false), a position can only be declared
  closed after `reportChallengeWindow` since it was opened (`PositionTooYoung`). The `mustClose()` exception is
  safe: none of its causes (close vote, more recent decision, pause) can be produced by the keeper
  alone, and a close requested by governance must never wait.
- The guardian has `reportChallengeWindow` to `revokeCloseReport` (for example if the position is still
  open on Hyperliquid); the position goes back to "open".
- `finalizeClose(decisionId)` (permissionless, after the window) measures **on-chain** what came back:
  `returned = usdg.balanceOf(vault) − usdgLedger`, i.e. all the USDG that came in from outside since the last
  accounting (Across relayer fill on the return, refund of an expired deposit, or **nothing at all**).
  **The keeper never declares an amount**: there is no parameter for it. `pnl = returned − capital`,
  `cumulativePnl += pnl`, the position is cleared, a new decision can execute.
- Loss paths: position liquidated or stopped out with nothing coming back → `returned = 0`, `pnl = −capital`, the
  vault continues with its remaining liquid NAV (`test_finalizeClose_nothingReturned_vaultNotBricked`). Across deposit
  never filled → the SpokePool refunds the vault (depositor) → `pnl ≈ 0`.
- **Cooldown after a losing close** (review L2): if `returned < capital`, `nextExecuteAt = now +
  reportChallengeWindow` and no order can execute before then (`ExecuteCooldown`). A "close with nothing coming
  back" is therefore public for an entire window before another dollar leaves: the guardian sees
  `PositionClosed(returned = 0)` and pauses. A fake-close cycle now costs ≥ 3 windows (age + challenge
  + cooldown), i.e. 18 h with the recommended values, on top of a new quorate decision. Why there is no
  "close requested by governance" exception here: the attack cycle *always* goes through a more recent
  decision (one is needed to re-execute), so exempting it would defeat the measure; the exception retained is
  "the capital came back", which is exactly the case where there is nothing to watch.
- Returns in several chunks (Across limit ≈ $278k/transfer, `RESEARCH.md` §3.2): whatever arrives after
  finalization is accounted for by `reconcile()` (keeper, closed position only). **Bounded** (review M2): an
  amount is only a **late return** (`LateReturn`, PnL upside) (a) within the `lateReturnWindow = 4 ×
  reportChallengeWindow` (24 h) following `finalizeClose`, and (b) up to `lateReturnAllowance = capital −
  returned` (what the position was short of at finalization). Everything else, and everything that arrives with no
  closed position, is a `Donation`: **principal, never distributable**. Rationale: a second Across chunk
  can legitimately *fill* a shortfall, but no external flow can prove that it is trading profit; when
  in doubt we keep it in the treasury without ever paying it out. Operational consequence: the keeper must
  wait for **all** chunks to have arrived before `reportClosed`, otherwise profit that arrives late remains
  principal (not distributed, but not lost). `reconcile` can only **increase** the ledger.
- **`depositPrincipal(amount)`** (review M2, permissionless, at any time, even while paused): the only correct way
  to add USDG to the treasury (partner, refund, top-up). The amount is pulled via `transferFrom`,
  measured, and added to the ledger **immediately**, so it is never measured as a position return nor accounted as
  PnL (`PrincipalDeposited`). A raw USDG transfer to the vault while a position is open or being closed is,
  on the other hand, attributed to that position by `finalizeClose`: this is documented, and the independent verifier compares
  `returned` against the Across fill.

### Worst the keeper can do with reports
- Report a fictitious equity → at worst a pointless close vote, if the guardian does not revoke; no funds
  move.
- Declare the close while nothing came back → after the window, an **accounting** `pnl = −capital` (the position
  remains real on Hyperliquid, controlled by the multisig) and a new decision becomes executable **after a
  one-window cooldown**: per-decision exposure is unchanged (≤ 20% of the **liquid** NAV, once per
  quorate decision), so the pace of governance decisions bounds the total outflow. The guardian has one window
  to revoke, then one more window to pause before the next order.
- Re-report before maturity to prevent a close vote → rejected (`ReportPending`).
- Spam reports after revocation → pausing blocks `reportPosition`.
- Book an external flow as profit via `reconcile` → bounded to the shortfall of the last close, within its window.
All of this is exercised in `WarchestVaultMaliciousKeeper.t.sol` and `WarchestVaultReviewRegression.t.sol`.

### Realized PnL, high-water mark and distribution anchor point
- `cumulativePnl` (signed) = Σ (`returned − capital`) of closed positions + bounded late returns. The hook's
  fees (ETH), ETH price moves, `depositPrincipal` and `Donation` are **principal**, never
  PnL: NAV is not the HWM basis, precisely so that external inflows are never
  "distributed" as profits.
- `highWaterMark` = cumulative PnL **already distributed**. It only moves in `pullDistributable` (+= amount), so it is
  monotonic (`invariant_pnlAndHighWaterMark`). After a loss, everything must be earned back before a single cent is
  distributable again (`test_highWaterMark_lossMustBeRecoveredFirst`).
- `distributable()` = `max(0, cumulativePnl − highWaterMark)`, capped by `usdgLedger`, and **0 while a position
  is open** (the result of the current position is not realized).
- `pullDistributable(amount)`: `distributor` only, immutable, set at deployment. `address(0)` = distribution
  **permanently disabled** for this deployment. It is the only entry point for the future `WarchestDistributor`
  (S3.4, D7). ⚠ Consequence: D7 (or at least the distributor's address/code, predictable via CREATE2) must be
  settled **before** the vault's mainnet deployment, otherwise the treasury will never be able to distribute; the
  vault address is itself immutable in the hook.

### Pause
`setPaused(true)` blocks `convertEthToUsdg`, `executeDecision`, `reportPosition` and `pullDistributable`, and sets
`mustClose()` to true: the keeper must unwind. `reportClosed`, `revokeCloseReport`, `finalizeClose` and
`depositPrincipal` remain available to bring back and account for funds. `receive()` is never blocked.

## 6. Roles (S3.1–S3.3)

| Role | Can | Can never |
|---|---|---|
| `keeper` (bot EOA, replaceable) | `convertEthToUsdg`, `executeDecision` within the bounds above (floor, circuit breaker, cap, cooldown); `reportPosition` (one at a time), `reportClosed` (minimum age except `mustClose`), `reconcile` (bounded) — information and accounting, never any movement of funds | send funds elsewhere, change a parameter, replay a decision, declare a returned amount, create distributable profit from an external flow |
| `guardian` (multisig, D9) | `setPaused`, `setKeeper`, two-step role transfer, `revokeReport` and `revokeCloseReport` during the challenge window | move funds, change the pool, the SpokePool, the recipient, the caps, force an accounting close |
| `distributor` (immutable, S3.4) | `pullDistributable(amount ≤ distributable())` | touch the principal or any profit below the high-water mark |
| governance | provide the current decision and the close request | call the vault (it only reads it via `closeVoteAllowed`) |
| anyone | send ETH, `depositPrincipal` (USDG, principal), `finalizeClose` after the window | — |

All parameters are `immutable`. Pausing blocks the keeper's actions, never `receive()`.

## 7. Mocks shipped
- `src/mocks/MockAcrossSpokePool.sol`: reproduces the checks of the real `deposit` (`quoteTimestamp` window,
  `fillDeadline` buffer, exclusivity rule, ERC20 pull, `depositId`, event) and holds the tokens;
  permissionless `release()` simulates a fill or a refund (**testnet only**, D6). Compiled with `via_ir`
  like the real SpokePool (12-parameter ABI).
- `test/mocks/MockUniswapV3Pool.sol` (decoupled TWAP and execution price), `MockWETH`, `MockUSDG`,
  `MockDecisionSource`.

## 8. Measured gas (mainnet fork, 2026-09-27)

| Function | Gas |
|---|---|
| `convertEthToUsdg(10 ETH)` cold | 296,974 – 304,012 before review; **359,695** with the circuit breaker (a second `observe` read over 6 h, binary search across the 10,809 observations) |
| `executeDecision` (real SpokePool) cold | 322,795 – 329,210 |

## 9. Tests
- `test/WarchestVaultConversion.t.sol`: construction, custody, conversion (happy paths, all reverts, sandwich,
  partial fill, oracle too short), callback, oracle math (rounding, upper branch), NAV, malicious keeper
  (fuzz), roles.
- `test/WarchestVaultExecute.t.sol`: constructor bounds (20% hard cap), happy path, Across deposit fields,
  all reverts (vault and SpokePool), cap on NAV with ETH at the floor, ledger, `mustClose`, bounds fuzzing,
  malicious keeper.
- `test/WarchestVaultGovernance.t.sol`: **real `WarchestGovernance`** (snapshot, votes, finalization) → execution only
  once, quorum fallback (D8) without reopening, superseded decision, staleness via `getRound().endsAt`.
- `test/invariant/VaultInvariant.t.sol`: ETH and USDG conservation (vault + SpokePool), ledger = balance, never sold
  below the floor, cap and recipient respected on every order, one execution per decision, consistent position,
  no funds held by keeper / guardian / attacker / recipient.
- `test/WarchestVaultReports.t.sol`: reports (window, rejection while pending, promotion, revocation),
  `closeVoteAllowed` (exact threshold, all "false" cases, "never reverts" fuzz), close (profit, loss, nothing
  returned + cooldown, Across refund, arrivals during the window, revocation), `reconcile` (late return bounded
  to the shortfall, in chunks, outside the window, donation), `depositPrincipal`, high-water mark and `pullDistributable` (disabled
  without a distributor).
- `test/WarchestVaultMaliciousKeeper.t.sol`: full stolen-key scenario and damage cap, worthless
  reports, early close, bridge fee bound, report spam, **the guardian never changes a
  balance**.
- `test/WarchestVaultGovernance.t.sol`: full cycle with the real governance, including the close vote
  (`startCloseRound` rejected while `closeVoteAllowed` is false), `isCloseRequested` → `mustClose` → close →
  new decision on a new snapshot.
- `test/fork/WarchestVaultFork.t.sol`: real pool, real WETH (proxy), real USDG, QuoterV2, 2,000 ETH dump before
  the conversion rejected by the floor, **real deposit on the Across SpokePool**, timestamp rejections by the real
  SpokePool. `test/fork/WarchestVaultOracleFork.t.sol`: dump **held** for 31 min on the real pool → floor −5.5%,
  circuit breaker tripped, conversion rejected; normal conditions → passes.
- `test/WarchestVaultReviewRegression.t.sol`: the review PoCs replayed against the fixes (§11); exact tick
  deviation at the threshold, the `mustClose()` exception to the minimum age, `DeploySystem` on the wrong chain.
- Invariants (`VaultInvariant.t.sol`, full handler: conversions, orders, reports, closes, simulated returns,
  reconciliations, principal deposits, short TWAP offset from the long one, revocations, pauses, distributor
  withdrawals, attackers): ETH and USDG conservation (vault + SpokePool + distributor), never sold below the
  floor, cap / recipient / one execution per decision, consistent position, `cumulativePnl` = Σ measured returns
  − capital + **bounded** late returns (principal deposits and donations never count), HWM = total distributed
  and monotonic, `distributable ≤ ledger`, **the guardian never moves a balance**, no funds held by keeper /
  attacker.

Test pitfall noted: the compiler caches `block.timestamp` within a function (constant in a real tx),
which breaks relative `vm.warp` calls; the vault tests read `vm.getBlockTimestamp()`.

## 10. Residual risks (out of the vault's reach)
- **Hyperliquid**: the stop-loss is a trigger order placed by the keeper; a compromised keeper may not place it,
  trade against a colluding counterparty (`RESEARCH.md` §2.3) or over-leverage. Mitigations: trading-only agent with
  short expiry, independent monitor, multisig as sole signer of returns. The vault only sees what comes back.
- **HL multisig (D4)**: sole guarantor of the return of funds; its HyperEVM key performs the HyperEVM → HyperCore step.
- **Across**: contract upgradable by Across; a new ABI without `deposit(bytes32,…)` would block
  `executeDecision` (fail-closed, funds intact). An unfilled deposit is refunded to the vault. A relayer can at
  worst capture `maxBridgeFeeBps`.
- **TWAP oracle**: a 30 min window bounded to ±2% of a 6 h window, on a $19.6M pool; the bound is
  "no worse than TWAP × 0.99", not "best price". Holding the price for 6 h against arbitrage remains theoretically
  possible: at that cost, the price has become the market. If the pool lost its liquidity or its history,
  conversions would fail (fail-closed).
- **Governance**: a malicious quorate decision (capture by a whale) is still a decision: the vault
  executes it within the 20% liquid-NAV limit, once.
- **Honest but absent keeper**: nothing happens; decisions expire (`maxDecisionAge`) and must be
  re-voted.
- **USDG (Paxos)**: regulated, upgradable token, with possible address freezing. A freeze of the vault would block
  conversions, orders and distributions (fail-closed, the ETH would be accessible to nothing: there is no ETH
  outflow other than the swap). To be assessed with legal (`RESEARCH.md` §6); Robinhood can also block addresses.
- **Distribution**: immutable and disabled by default; the D7 choice gates the deployment (see §5). Residual
  trust in the distributor (HIGH review finding, fixed): after a **public updater rotation of at least 4 days**
  (`updaterDelay = timelock + 3 d`) followed by the root timelock, the guardian + updater pair can still misallocate
  **already funded** profit (never the principal: the vault only releases `distributable()`). The independent verifier
  has ≥ 5 days of public events (`UpdaterChangeProposed`, `RootProposed` + `treeHash`) to detect it; see
  `DISTRIBUTOR.md`.
- **"Deployer = temporary guardian" window** (`DeploySystem`): between deployment and the multisig's `acceptGuardian()`
  on the three contracts, the deployment key holds all of the guardian's powers (pause, keeper rotation,
  report veto, *delayed* updater rotation, cancellation of its own transfer) but **cannot move
  funds**. Instruction: fresh key taken offline after the script, acceptance by the multisig before any
  capital flow, no treasury liquidity during the window. See `DEPLOY.md`.

### Decisions for the owner (review findings deliberately NOT implemented)
- **M3 — no exit or migration.** The vault has no owner, no proxy and no withdrawal function: the only exit
  for funds is the conversion → order → return cycle. If Across, the v3 pool, USDG or Hyperliquid become
  unusable, or if the token has to migrate, the treasury is **locked forever** (absolute fail-closed, ETH
  does not even have an exit other than the swap). The reviewer's reasoning: the only acceptable form would be a **governance-voted
  sunset, under a long timelock, to a successor chosen by governance** (never by the
  guardian, D9); any other form reintroduces precisely the withdrawal key the design rejects. This is a
  **product decision** (full immutability vs. governed exit door), not a technical fix: to be
  settled by the project owner before the mainnet deployment, since it cannot be added afterwards.
- **L4 / L5 (review, low).** Not implemented; the original text of these two findings was not attached to the PoCs
  provided, they are summarized here from the review context and **must be reconciled with the original report by the
  owner**: (L4) the honest keeper remains solely responsible for the actual `minOut` — the
  `max(twapFloor, quoter × 0.999)` policy (§2) is an off-chain instruction, not an on-chain guarantee; (L5) `nav()` values
  ETH at the 30 min TWAP without the 6 h circuit breaker — an inflated short TWAP raises the `maxOrderAmount()` cap,
  which is bounded anyway by `usdgLedger` (we never bridge more than the accounted USDG) and by one execution per
  decision. Extending the circuit breaker to `nav()` would cost one extra oracle read per order for a bound already
  covered by the ledger; left to the owner's discretion.

## 11. Security review (2026-09-27)
Fixed findings, each covered by a regression test (`WarchestVaultReviewRegression.t.sol`,
`WarchestDistributor.t.sol`, `test/fork/WarchestVaultOracleFork.t.sol`):
- **High (distributor)**: the guardian could instantly appoint itself updater and pay itself all the funded profit
  → public delayed rotation `proposeUpdater / cancelUpdaterChange / applyUpdaterChange` (`updaterDelay = timelock
  + 3 d`), modeled on governance; `setUpdater` removed.
- **Medium M1**: a dump held for 30 min moved the TWAP and the floor → 30 min vs 6 h TWAP circuit breaker
  (`OracleDeviation`, `oracleStable()`, `longTwapTick()`, `maxTwapDeviationTicks`).
- **Medium M2**: any external USDG became distributable profit → `depositPrincipal`, late returns bounded to the
  shortfall of the last close and to `lateReturnWindow`.
- **Low L1**: re-reporting before maturity suppressed take-profit votes → `ReportPending`.
- **Low L2**: fake-close cycles → minimum age `PositionTooYoung` (except `mustClose()`) and cooldown
  `ExecuteCooldown` after a losing close (`nextExecuteAt`).
- **Low L3**: `DeploySystem` rejects any chain ≠ 4663 (`WrongChain`); temporary-guardian window documented.
- **M3, L4, L5**: not implemented, see §10.

Vault ABI: no existing function, signature or struct has changed; additions only (`depositPrincipal`,
`longTwapTick`, `oracleStable`, `LONG_TWAP_WINDOW`, `maxTwapDeviationTicks`, `lateReturnWindow`, `lastClosedAt`,
`lateReturnAllowance`, `nextExecuteAt`, event `PrincipalDeposited`, errors `OracleDeviation`, `ReportPending`,
`PositionTooYoung`, `ExecuteCooldown`, `ZeroAmount`) and new revert conditions. The keeper must: read
`oracleStable()` / handle `OracleDeviation` before converting, only report after the previous report has matured,
wait for `openedAt + reportChallengeWindow` before a self-initiated `reportClosed`, and read `nextExecuteAt()`
before `executeDecision`.
