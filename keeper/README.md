# WARCHEST — keeper

Off-chain bot (Node ≥ 24, TypeScript, viem, `node:sqlite`) that executes governance decisions on Hyperliquid:

1. reads `governance.currentDecision()` and the vault state (source of truth, never invented);
2. converts the vault's ETH into USDG (`convertEthToUsdg`, bounded by the on-chain TWAP floor);
3. bridges the capital via Across (`executeDecision`, parameters taken from `/suggested-fees` and `/limits`);
4. opens the position on Hyperliquid with the **trading-only agent** (isolated margin, vault leverage), places the stop-loss
   and the take-profit **after** the fill and reads them back;
5. reports equity (`reportPosition`), closes when `mustClose()` is true, prepares the return instructions for
   the **multisig** (D4: the keeper never signs a withdrawal), then `reportClosed` / `finalizeClose` / `reconcile`.

```bash
npm ci
npm test            # unit + anvil integration (real contracts, skipped without anvil/artifacts)
npm run smoke       # LIVE read-only: Robinhood mainnet RPC, Hyperliquid /info, Across API
npm run keeper once # one tick (dry-run by default)
npm run keeper run  # loop
npm run keeper status
npm run keeper monitor [once]   # independent monitor (exit code 2 on a red finding)
npm run keeper kill [reason]    # kill switch: cancel all + reduce-only close (MODE=live)
npm run keeper return-plan [usdc] # return plan for the multisig (read-only)
npx tsx scripts/sigproof.ts     # signature proof against the HL testnet (throwaway key, 5 requests)
```

## Modes
- **`MODE=dry-run`** (default): reads everything, computes and logs each planned action (`WOULD …`), signs nothing.
- **`MODE=live`**: signs vault txs with `KEEPER_PRIVATE_KEY` (`src/chain/writer.ts`, every tx is
  **simulated** before sending: nothing is broadcast if the vault would revert) and Hyperliquid L1 actions with
  `HL_AGENT_PRIVATE_KEY`. Refused on Robinhood mainnet without `ALLOW_MAINNET=1`.

Configuration: see `.env.example`.

## Security invariants
- **The Hyperliquid agent can never withdraw.** The keeper holds only the agent key and builds only
  L1 actions (`order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`, `updateLeverage`, `updateIsolatedMargin`,
  `scheduleCancel`). Any other action type is refused **in the signing layer** (allowlist, S5.2); the
  EIP-712 domain `HyperliquidSignTransaction` (withdrawals, transfers, `approveAgent`…) does not exist in the code.
- **The vault and governance are the source of truth**: asset and side = `currentDecision()`, leverage / stop /
  take-profit = `vault.riskParams()` (immutable), capital = position recorded by the vault. Every vault bound
  (`_checkDecision`, `_checkOrder`, SpokePool windows) is re-checked locally before building a tx
  (`src/planner.ts`).
- **Closed asset list** (`ALLOWED_ASSETS`, default `BTC,ETH,SOL`): a decision outside the list, a delisted asset or
  an unknown index is refused (fail-closed) and reported.
- **Fail-closed on protection**: if the stop-loss cannot be read back in `frontendOpenOrders`, the position
  is flattened.
- **Return of funds**: `reportClosed` is only sent once ≥ `RETURN_TOLERANCE_BPS` of the expected equity
  is back in the vault (`balance − usdgLedger`), or with the explicit override `FORCE_REPORT_CLOSED_ID`.

## Hyperliquid signing (S5.2): in-house signer, no SDK
The keeper does **not** use `@nktkas/hyperliquid` (4 transitive dependencies, WebSocket, and above all a client that
exposes `withdraw3`, `usdSend`, `approveAgent`… on the same object). It ships a minimal signer
(`src/hyperliquid/msgpack.ts` ≈ 120 lines, `signer.ts` ≈ 120 lines):
- action hash = `keccak256(msgpack(action) ‖ nonce ‖ vaultAddress? ‖ expiresAfter?)`, phantom agent
  `{source: "a"|"b", connectionId}`, EIP-712 domain `Exchange` / chainId 1337;
- **allowlist** in `AgentSigner.sign`: `order`, `cancel`, `cancelByCloid`, `modify`, `batchModify`,
  `updateLeverage`, `updateIsolatedMargin`, `scheduleCancel`. Any other type is refused before hashing, as is
  any user-signed action field (`signatureChainId`, `destination`, `amount`, `agentAddress`, `builder`…). The
  `HyperliquidSignTransaction` domain exists nowhere in the code.
- Verified bit for bit against the official Python SDK vectors (`tests/signing_test.py`: dummy, order, order+cloid,
  vault, TP/SL, mainnet and testnet) and against the `@msgpack/msgpack` encoder (differential).

**Proof against the testnet** (`scripts/sigproof.ts`, 2026-09-27): a random, never-approved key signs
actions and posts them to `api.hyperliquid-testnet.xyz/exchange`; the API responds
`User or API Wallet 0x… does not exist.` with **the address it recovered**:
```
PASS order (no vault, no expiry)                     recovered = ours
PASS order + expiresAfter                            recovered = ours
PASS order + vaultAddress (sub-account) + expiresAfter recovered = ours
PASS updateLeverage isolated 3x + vaultAddress       recovered = ours
PASS tampered nonce (negative control)               recovered ≠ ours
```

## Trading engine (S5.2, `src/hyperliquid/engine.ts`)
- `open`: `updateLeverage(isolated)` → arms `scheduleCancel` → **one** price-bounded IOC order, deterministic `cloid`
  `(decision, "entry", attempt)` → disarms → reads the position back: isolated mode and leverage verified, otherwise
  flatten. A `cloid` already known to the API is **never resent** (restart between send and persistence).
- `protect`: stop (mandatory) and take-profit (optional) as **reduce-only** triggers, `positionTpsl` grouping,
  opposite side, limit price at `TRIGGER_LIMIT_BPS` from the trigger, then **read-back** in `frontendOpenOrders`
  (coin, trigger, reduce-only, side, price, size). Not read back ⇒ `verified=false` ⇒ the keeper flattens.
- `close`: cancel the coin's orders + reduce-only IOC; `killSwitch`: cancel **all** orders + reduce-only close
  of **all** positions, alert if anything remains.
- ⚠ **Dead-man switch**: `scheduleCancel` cancels *all* orders, **including the stop-loss**. It is therefore only armed
  around the entry order and disarmed before placing the stop; if disarming fails after a fill, the
  position is flattened. It must never remain armed on a protected position (and the API reserves it for accounts
  with sufficient volume: arming is *best effort*).

## Independent monitor (`src/monitor.ts`)
Shares no state with the loop. On each pass it checks: position only on the decision's coin,
side, isolated margin, leverage = `riskParams`, value ≤ capital × leverage (+5%), reduce-only stop present and no further
than `stopLossBps`, no non-reduce-only order, agent approved and not expiring, `mustClose`. A red finding
is alerted (once per continuous condition) and, with `MONITOR_KILL=1` in live mode, triggers the kill switch.

## Across bridge (S5.3, `src/across/bridge.ts`)
- **Outbound**: executed by the vault itself (`executeDecision`, immutable recipient). The keeper picks
  `amount = min(cap 20% NAV, ledger, maxDepositInstant)`, takes `outputAmount / timestamp / fillDeadline` from
  `/suggested-fees`, checks `outputAmount ≥ amount × (1 − maxBridgeFeeBps)`, the `quoteTimestamp` window
  (1 h), `fillDeadline ≤ 6 h` and `≥ MIN_FILL_MARGIN_SEC`, and that the quote's SpokePool is the vault's.
- **Tracking**: `/deposit/status` combined with the vault's `balance − usdgLedger` (`classifyDeposit`): a refund
  of an expired deposit is detected on-chain even if the API lags; an expired deposit is reported and the keeper
  waits for the SpokePool refund (depositor = vault), then closes the decision without trading.
- **Return** (`planReturn`): `withdrawable` of the trading account → split according to `/limits` of the route
  `999 USDC → 4663 USDG` (≈ $246k instant on 2026-09-27), indicative quote per chunk, and the list of steps
  that **the multisig** must sign (`subAccountTransfer` → `usdClassTransfer` → `spotSend` to the system address
  `0x2000…0000` → Across deposits on HyperEVM with `recipient = vault`), plus the `withdraw3` → Arbitrum alternative.
  The keeper signs none of this.
- **Without an Across testnet (D6)**: the `test/live.integration.test.ts` integration runs a full decision
  on anvil with the real vault and the `MockAcrossSpokePool` (real deposit, `release()` to simulate the return).

## Return, reports, kill switch (S5.4)
- `reportPosition(decisionId, equity)` every `REPORT_INTERVAL_MS` (6 h) during `holding`, equity = `accountValue`
  of the trading account. Purely informational on the vault side (guardian challenge window).
- `mustClose()` (guardian pause, voted close, superseded decision) ⇒ `closing`: cancel + reduce-only IOC ⇒
  `closed_on_hl` ⇒ `RETURN PLAN` (critical alert, `keeper status`, `keeper return-plan`) ⇒ `awaiting_return`.
- `reportClosed` only when `balance − usdgLedger ≥ RETURN_TOLERANCE_BPS × final equity` (or
  `FORCE_REPORT_CLOSED_ID`), `finalizeClose` after the window, `reconcile` for late chunks.
- Kill switch: `keeper kill`, the monitor (`MONITOR_KILL=1`), or automatically when a protection is
  unverifiable / a leverage is non-compliant. Alerts: console + `ALERT_WEBHOOK_URL` (JSON POST, never blocking).
- Incident procedures: **`RUNBOOK.md`**.

## Decision lifecycle (`src/keeper.ts`, persisted in SQLite)
```
idle ──executeDecision──▶ bridging ──fill Across──▶ funding ──USDC on the trading account (multisig)──▶ opening
  ──IOC filled──▶ protecting ──stop read back──▶ holding ──mustClose / stop / TP──▶ closing ──flat──▶ closed_on_hl
  ──instructions to multisig──▶ awaiting_return ──USDG back──▶ report_closed ──6 h window──▶ finalized
```
Each stage is re-derived from the observed state (vault, governance, Hyperliquid, Across): a restart resumes at
the right place, and a position with no local history is **adopted** from the chain.

## D5 step 3 (HyperEVM → HyperCore) and return
The keeper cannot move funds on HyperEVM or on HyperCore (agent key). It **waits** for the USDC on the
trading account and publishes the instructions (alert): HyperEVM transfer → system address `0x2000…0000`,
`usdClassTransfer`, `subAccountTransfer`. Same for the return (S5.4): `withdraw3` / Across `999 → 4663` split
according to `/limits`, signed by the multisig.

## Profit taking
`TAKE_PROFIT_TRIGGER=1` (default) places a "take profit" trigger at `takeProfitBps / leverage` from the entry price, i.e.
`takeProfitBps` of the capital. With `0`, the keeper places only the stop and lets governance vote the close via
`closeVoteAllowed` (reported equity ≥ threshold). The choice belongs to the project owner.

## Live smoke test (2026-09-27, read-only)
```
[rpc] chainId=4663 block=73667949
[across spoke pool] numberOfDeposits=373002 depositQuoteTimeBuffer=3600 fillDeadlineBuffer=21600
[quoter v2] 1 ETH → 2691.49 USDG
[hl] 0=BTC szDecimals=5 maxLev=40 mid=84295.5 → long 3x: entry≤84296 stop=80080 tp=87102
[hl] 1=ETH szDecimals=4 maxLev=25 mid=2692.85 → long 3x: entry≤2692.9 stop=2558.2 tp=2782.5
[hl] 5=SOL szDecimals=2 maxLev=20 mid=120.145 → long 3x: entry≤120.15 stop=114.13 tp=124.14
[across] 4663 USDG → 999 USDC: min=0.50 maxInstant=260534.15 max=542794.73
[across] 10000$ → out=9994.00 fee=6bps eta=2s  (quoteTs +7200s = fillDeadline)
[across] 100000$ → out=99940.00 fee=5bps eta=98s
[across] 999 USDC → 4663 USDG (return): min=0.50 maxInstant=246229.76 max=246229.76
```

## Tests
- `rounding`: Hyperliquid tick/lot rules (5 significant figures, `6 − szDecimals` decimals), exact decimal
  arithmetic;
- `planner`: every vault and SpokePool bound, allowlist, sizing, protection prices;
- `keeper`: full state machine with a scripted executor (partial fill, missing stop, unverified stop →
  flatten, Across refund, return timeout, override, adoption, agent expiry);
- `chain.integration`: real `WarchestGovernance` + `WarchestVault` on anvil (real quorate decision, real
  conversion, valid `executeDecision` plan).
