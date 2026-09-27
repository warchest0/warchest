# WARCHEST keeper — incident runbook

> Scope: the `keeper/` bot, the Hyperliquid account (D4 multisig + sub-account + agent), the Across bridge and
> calls to `WarchestVault`. The contracts are frozen; nothing here changes an on-chain parameter.

## 0. What each key can and cannot do

| Key | Held by | Can | Can never |
|---|---|---|---|
| Hyperliquid agent (`HL_AGENT_PRIVATE_KEY`) | keeper | `order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `updateLeverage`, `updateIsolatedMargin`, `scheduleCancel` (allowlist in `signer.ts`) | withdraw, transfer (`withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `usdClassTransfer`, `vaultTransfer`, `subAccountTransfer`), approve an agent or a builder |
| Robinhood keeper (`KEEPER_PRIVATE_KEY`) | keeper | `convertEthToUsdg` (≥ TWAP floor), `executeDecision` (≤ 20% NAV, once per decision, immutable recipient), `reportPosition`, `reportClosed`, `reconcile` | send funds elsewhere, declare a returned amount, replay a decision |
| HL multisig (D4) | signers | everything on the HL account, including returning the funds | — |
| Guardian (D9) | multisig | `setPaused`, `setKeeper`, revoke a report | move funds |

Consequence: **a keeper compromise cannot move funds out**; at worst it can trade badly on
Hyperliquid (RESEARCH §2.3) or execute a decision at the wrong time. The response to any compromise is the
same: pause + kill switch + rotate both keys.

## 1. Commands

```bash
npm run keeper once            # one tick, dry-run by default (MODE=dry-run)
npm run keeper run             # loop
npm run keeper status          # SQLite runs + last 20 events
npm run keeper monitor once    # independent monitor; exit code 2 = red finding
npm run keeper kill "reason"   # MODE=live: cancel all + reduce-only close of the whole account
npm run smoke                  # live read-only (RPC, HL /info, Across)
npx tsx scripts/sigproof.ts    # testnet signature proof (throwaway key)
```

Run the monitor **in a separate process** (`MONITOR_KILL=1` so it can trigger the kill
switch itself), ideally on a separate machine: it needs only the agent key (kill) or no key at all
(alert only).

## 2. Alerts and expected response

| Alert | Severity | Response |
|---|---|---|
| `keeper key is not the vault keeper` | critical | The guardian rotated the keeper or the config is wrong. Nothing will be executed. Check `vault.keeper()`. |
| `agent not approved on the Hyperliquid account` | critical | The multisig must `approveAgent` with **a new address** (never reuse an agent address, RESEARCH §2.1). Update `HL_AGENT_PRIVATE_KEY`. |
| `agent expires soon` | warning | Same, before `validUntil` (≤ 30 d, D4). An open position stays protected by its HL on-chain stop during the rotation. |
| `funds on HyperEVM: multisig action required` | warning | D5 step 3: the multisig's EVM key sends the USDC to `0x2000…0000` (HyperCore), then `usdClassTransfer` spot → perp, then `subAccountTransfer` to the trading account. The keeper waits for `withdrawable ≥ 99%` of `outputAmount`. |
| `openPosition refused` / `executeDecision refused` | critical / warning | Read the reason (`allowlist`, `delisted`, `max leverage`, `stop-loss beyond safe distance`…). This is a deliberate fail-closed: do not bypass it; if the decision is legitimate, fix the config or wait for a new decision. |
| `stop-loss could not be verified, flattening` | critical | The keeper has already flattened. Check on HL that no position remains; otherwise `keeper kill`. Do not reopen manually: the keeper will retry on the next tick (bounded attempts). |
| `stop-loss missing while holding: re-protecting` | critical | Someone cancelled the stop (or `scheduleCancel` stayed armed). The keeper re-places the stop; if that fails, it flattens. Find the cause (another agent? manual multisig action?). |
| `position margin mode / leverage differs` | critical | Flattened automatically. Check that no other agent is changing the leverage. |
| `monitor <CODE>` | red / yellow | See §3. |
| `position closed on Hyperliquid (stop, take-profit or liquidation)` | warning | Normal. The keeper moves to `closed_on_hl` and then emits the return plan. |
| `RETURN REQUIRED: multisig must bring the funds back` | critical | Execute the plan (§4). |
| `funds not back after the return timeout` | critical | Chase the signers. The vault stays blocked (no new decision) until `reportClosed` + `finalizeClose` have gone through. |
| `Across deposit expired` / `refunded` | warning | The SpokePool refunds the vault (depositor). The keeper closes the decision without trading: `reportClosed` then `finalizeClose` with `returned ≈ capital`. |
| `KILL SWITCH` / `kill switch: positions remain` | critical | If positions remain: rerun `keeper kill`, otherwise close manually from the multisig (master key). |
| `entry attempts exhausted` | critical | 5 IOCs without a fill (liquidity / price out of bounds). Human decision: wait, widen `ENTRY_SLIPPAGE_BPS`, or let it expire. |

## 3. Monitor codes

| Code | Meaning | Action |
|---|---|---|
| `POSITION_WITHOUT_VAULT` | HL position while the vault has no position | Kill switch. Someone is trading with the account. Rotate the agent. |
| `FOREIGN_POSITION` / `ASSET_NOT_ALLOWED` | coin ≠ decision | Kill switch. |
| `SIDE_MISMATCH`, `MARGIN_MODE`, `LEVERAGE`, `SIZE_EXCEEDS` | position not compliant with `riskParams` | Kill switch (the keeper should already have flattened it; check that it is running). |
| `STOP_MISSING`, `STOP_TOO_FAR` | protection missing or too loose | The keeper re-places the stop. If the code persists for more than one interval: kill switch. |
| `UNEXPECTED_ORDER` | non-reduce-only order or order on another coin | Red if non-reduce-only: kill switch. Yellow otherwise: investigate. |
| `AGENT_MISSING` / `AGENT_EXPIRING` | agent | Rotate (§2). |
| `MUST_CLOSE` | the vault requests the close | Check that the keeper is in `closing`; otherwise `keeper kill`. |

## 4. Return of funds (signed by the multisig, never by the keeper)

The keeper emits a `RETURN PLAN` (alert + log) with the exact amounts. Order of steps:
1. `subAccountTransfer` from the sub-account to the master (if sub-account).
2. `usdClassTransfer` perp → spot on the master.
3. `spotSend` USDC to the system address `0x2000000000000000000000000000000000000000` (HyperCore → HyperEVM).
4. On HyperEVM (999), one Across deposit per chunk (`/limits`, ≈ $246k instant): `inputToken` USDC
   `0xb883…630f`, `outputToken` USDG `0x5fc5…d168`, `destinationChainId` 4663, **`recipient` = the vault**,
   `outputAmount` ≥ fresh quote (`/suggested-fees`, re-quote at signing time: `quoteTimestamp` ≤ 1 h,
   `fillDeadline` ≤ 6 h).
5. The keeper sees `balance − usdgLedger ≥ RETURN_TOLERANCE_BPS × expected` and sends `reportClosed`; 6 h
   later anyone can `finalizeClose`. Chunks arriving afterwards are accounted for by `reconcile`.

Alternative: `withdraw3` to Arbitrum (~3–5 min, $1) then Across `42161 USDC → 4663 USDG` to the vault.

If part of the capital is **permanently lost** (liquidation): the return is partial; use
`FORCE_REPORT_CLOSED_ID=<id>` so the keeper sends `reportClosed` below the threshold. The guardian has 6 h
to revoke. Never force while funds remain on Hyperliquid.

## 5. Procedures

### 5.1 Pause (guardian) ⇒ unwind
`vault.setPaused(true)` ⇒ `mustClose()` true ⇒ on the next tick the keeper cancels orders, closes reduce-only,
emits the return plan. `reportClosed` and `finalizeClose` remain allowed while paused. The position is **not**
reopened on unpause (D8: a new quorate decision is required).

### 5.2 Compromised agent key
1. `keeper kill` (or let the monitor do it); 2. the multisig revokes the agent (`approveAgent` with a new
address; the old one is unusable after expiry; for immediate effect, move the funds out of the
sub-account: `subAccountTransfer` to the master); 3. new `HL_AGENT_PRIVATE_KEY`; 4. restart.

### 5.3 Compromised Robinhood keeper key
1. Guardian: `setPaused(true)` then `setKeeper(new address)`; 2. maximum losses are bounded by the vault
(`VAULT.md` §4–5); 3. restart with the new key, unpause.

### 5.4 Keeper stopped / SQLite database lost
Restart. An open position with no local history is **adopted** from on-chain + HL state (inferred stage:
`protecting` if position, `opening` if USDC available, `funding` if deposit filled, otherwise `bridging`); the
protection is re-verified before moving to `holding`. Deterministic `cloid`s prevent any double send.

### 5.5 Hyperliquid unavailable
The stop-loss is an **HL on-chain** trigger: it stays active without the keeper. The keeper retries with backoff
(≤ 10 min). Do nothing until `/info` responds; do not arm `scheduleCancel`.

### 5.6 Across does not fill
`fillDeadline` (≤ 6 h) passed ⇒ refund to the vault in a later bundle (can take hours). The keeper
waits and closes without trading. Do not rerun `executeDecision`: the decision is already consumed (`id ≤ last`).

### 5.7 Decision on an asset outside the allowlist / delisted
Fail-closed refusal, alert. The decision expires (`maxDecisionAge`); governance must vote again. Do not widen
`ALLOWED_ASSETS` under pressure.

### 5.8 Dead-man switch left armed
`scheduleCancel` cancels **the stop too**. Symptom: `STOP_MISSING` at regular intervals. Response: the keeper
re-places the stop; disarm with `scheduleCancel` without `time` (the keeper does this on the next entry) and check
`DEADMAN_MS`.

## 6. Before any real capital (human blockers)
- [ ] S0.2: raw proofs of rejection of `withdraw3` / `usdSend` / `vaultTransfer` / `subAccountTransfer` /
      `approveAgent` by an agent on the HL testnet, on a **funded** account (the faucet requires a mainnet deposit).
- [ ] HL account converted to multisig (`convertToMultiSigUser`), sub-account created, agent approved ≤ 30 d.
- [ ] S0.3: small real Across transfer RH → HyperEVM → HyperCore and back; measure delays, fees, steps.
- [ ] `HL_ACCOUNT` = `vault.bridgeRecipient()` (immutable); `ALLOWED_ASSETS` = names of the governance's
      `eligibleAssets` on the target HL network (indexes differ between mainnet and testnet).
- [ ] Monitor on a separate machine with `MONITOR_KILL=1`.
- [ ] 48 h of `MODE=dry-run` without errors (plan criterion S5.1).
