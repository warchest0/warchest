# WARCHEST — RESEARCH.md

> Research verified as of **2026-09-27**. Legend: **[V]** Verified (source or live call), **[I]** Inference, **[TO MEASURE]** requires a real measurement (spike S0), **[TO TEST]** requires a test on testnet.
> Rule #1: no line of production code until the **[TO MEASURE]/[TO TEST]** items below are closed.

---

## 0. Feasibility verdict (summary)

| Component | Feasible? | Comment |
|---|---|---|
| ERC20 token + v4 hook with 10% fee | **Yes** [V] | Official v4 on Robinhood Chain mainnet; 10% TaxHooks already exist on the chain. |
| Levels × supply governance | **Yes, with a design change** | The balance must be snapshotted (not `live balance × level`) → merkle root per epoch. |
| Vault (20% cap, stop-loss) | **Yes, partially** | The 20% cap is enforceable on-chain. The **stop-loss is not** from Robinhood Chain: it lives on Hyperliquid (trigger orders). |
| Hyperliquid agent without withdrawal | **Yes** [V] | Enforced by the protocol's signature scheme. 2 ambiguous actions to test (see §2). |
| Across bridge RH ↔ Hyperliquid | **Yes, but not as described** | No native USDC on RH (USDG), no direct route to HyperCore, **no Across testnet**, return capped at ~$278k/transfer. |
| Full E2E on testnet | **Partial** | v4 is indeed on the RH testnet (same addresses). However Across has no testnet, so the bridge is simulated. |
| 6-week schedule | **No** | Realistic: 12–16 weeks, including 4–8 weeks of audit. |
| Legal | **Major risk** | Profit sharing strongly resembles an investment contract (Howey) / UCI (EU). |

---

## 1. Robinhood Chain + Uniswap v4

### 1.1 The chain [V]
- Mainnet live since **2026-07-01**, Arbitrum Orbit, gas in ETH. Chain ID **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `robinhoodchain.blockscout.com`. — https://docs.robinhood.com/chain/deploy-smart-contracts
- Testnet: chain ID **46630**, RPC `https://rpc.testnet.chain.robinhood.com` (both confirmed via `eth_chainId`).
- **Permissionless** deployment. No KYC policy found for third-party token launches, which does not prove there is none.
- **~100 ms** blocks (measured: 10,000 blocks in 1,009 s). Single Robinhood sequencer in FCFS: the priority fee reorders nothing.
- Gas: ~0.025 gwei observed. Peak of 0.511 gwei on Sept 3 (median tx $0.006 → $0.20). — https://bitquery.io/investigations/robinhood-chain-gas-price-25x
- Orbit specifics: `block.number` returns an L1 estimate (use `ArbSys.arbBlockNumber()`), max code size 96 KB. — https://docs.robinhood.com/chain/differences-from-ethereum/
- Terms of Service (2026-02-10): Robinhood can **block addresses**, prohibits illegal activity and **prohibits use of the Robinhood brand** for a token issuance. — https://docs.robinhood.com/chain/terms-of-service

### 1.2 Uniswap v4 on Robinhood Chain [V]
Announcement: https://blog.uniswap.org/robinhood-chain-is-live — addresses: https://developers.uniswap.org/docs/protocols/v4/deployments

| Contract | Address (mainnet 4663) |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` (v2.1.2: `0x204FAca1764B154221e35c0d20aBb3c525710498`) |
| Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

- ✅ **CORRECTION (verified on 2026-09-27, after the initial research)**: v4 **is** deployed on testnet 46630, **at the same addresses** as on mainnet.
  - PoolManager, Quoter and StateView have **identical bytecode** to mainnet (comparison of sha256 hashes of `cast code`).
  - PositionManager and UniversalRouter are present, with different bytecode (testnet-specific immutables).
  - Permit2 and the CREATE2 deployer `0x4e59…956C` are present too.
  - The full launch script (`contracts/script/DeployWarchest.s.sol`) was run successfully on a testnet fork and a mainnet fork.

### 1.3 Hook ABI and behavior [V]
Sources: `v4-core/src/libraries/Hooks.sol`, `IHooks.sol`, `types/BeforeSwapDelta.sol`, `LPFeeLibrary.sol`.

- **Permissions encoded in the 14 low bits of the hook address**:
  - `beforeSwap` = `1<<7`, `afterSwap` = `1<<6`, `beforeSwapReturnsDelta` = `1<<3`, `afterSwapReturnsDelta` = `1<<2`.
  - Address obtained by CREATE2 salt mining with `HookMiner`, which now lives in `Uniswap/v4-hooks-public` (and no longer in v4-periphery).
- Signatures:
  - `beforeSwap(sender, key, params, hookData) returns (bytes4, BeforeSwapDelta, uint24)`
  - `afterSwap(sender, key, params, delta, hookData) returns (bytes4, int128)`
- `amountSpecified < 0` = exact input. If the hook's delta flips the sign of the swap, the swap reverts with `HookDeltaExceedsSwapAmount`.
- **Always take the fee in ETH** (Stakd pattern):
  - ETH = `address(0)` = **currency0**, so `zeroForOne == true` = buy, `false` = sell.
  - If ETH is the *specified* currency → fee taken in `beforeSwap`.
  - If ETH is the *unspecified* currency → fee taken in `afterSwap` (`int128` return).
  - Collection via `poolManager.take` or ERC-6909 mint.
  - There are therefore 4 cases to cover: buy/sell × exactIn/exactOut.
- The "dynamic LP fee" alternative (`MAX_LP_FEE = 1_000_000`) **is not suitable**: the fee goes to LPs, not to the vault.
- ⚠️ **Routing**: a hook with `*ReturnsDelta` is **not routed by the Uniswap app or API** until it is validated on the hook allowlist (verified source required). — https://developers.uniswap.org/hook-allowlist
  - Accepted precedents on Robinhood Chain: `TaxHook` up to 10% (https://github.com/Uniswap/hooklist/pull/10290), PeepsV4TaxHook, RiboV4TaxHook.
- Recommended codebase: OpenZeppelin `uniswap-hooks` (`BaseHook`, `BaseHookFee`).

### 1.4 The "Stakd" reference: to be corrected in the whitepaper [V]
- Stakd exists (https://github.com/Stakdofficial/Stakd). It takes **1–5% + 1% creator (max 6%), not 10%**, sends the fees to Lighter perps, and its README states **"not independently audited"**.
- The closest reference to our design is `TaxHook` `0xa06cf6ca09f5a885941d4c4084cc39161b31c044`: 10% in `afterSwap` on the unspecified currency, sent to a treasury, verified source.
- Other open-source references: Flaunch, Clanker v4, Doppler.
- → The whitepaper sentence "pattern validated in production by Stakd" is **inaccurate**. To be reworded.

---

## 2. Hyperliquid — "trading only" agent wallet

### 2.1 Enforcement [V]
Sources: https://hyperliquid.gitbook.io/hyperliquid-docs (signing, exchange-endpoint, builder-codes) and the python SDK `signing.py` / `exchange.py`.

- The protocol uses **two distinct signature schemes**:
  - **L1 actions** ("Exchange" domain, signable by an agent): `order` (TP/SL included), `cancel`, `modify`, `batchModify`, `scheduleCancel`, `updateLeverage`, `updateIsolatedMargin`, `twapOrder`…
  - **User-signed actions** (EIP-712 "HyperliquidSignTransaction", **master key required**): `withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `usdClassTransfer`, `approveAgent`, `approveBuilderFee`, `convertToMultiSigUser`.
- → **No-withdrawal is enforced by Hyperliquid itself** through signature verification, not by the client. The docs say so explicitly for `approveBuilderFee`; for the rest, it follows from the signature scheme.
- `agentSendAsset` is signable by an agent, but the "destination must equal the source": it is only an internal movement.
- Agent limits:
  - 1 unnamed agent + 3 named agents per account, and 2 more per sub-account.
  - `valid_until` expiry ≤ 180 days.
  - **Never reuse an agent address**, because nonces can be replayed after pruning.

### 2.2 Gray areas [TO TEST]
- Third-party sources contradict each other on whether an agent can sign **`vaultTransfer`** and **`subAccountTransfer`** (the SDK signs them with `sign_l1_action`).
- → Mandatory test on the HL testnet: an agent attempts `withdraw3`, `usdSend`, `vaultTransfer`, `subAccountTransfer` and `approveAgent`. The rejections are recorded here, with the raw API responses.

### 2.3 Possible value leaks even without withdrawal [V/I]
- **Theft via a colluding counterparty**: a compromised agent can trade at a loss against the attacker's orders on an illiquid market. Self-trade prevention only blocks the same address. **This is risk #1.**
- Leverage adjustable up to the asset's max, so forced liquidation is possible. TWAP slippage up to 3%.
- Mitigations:
  - closed list of liquid assets only;
  - isolated margin, fixed leverage checked by an independent monitor;
  - `scheduleCancel` as a dead-man switch;
  - short agent rotation;
  - revocation by replacement.

### 2.4 Who holds the master key (the real trust point) [V]
- **Native HyperCore multisig**: `convertToMultiSigUser`, up to 10 signers plus a threshold. — https://hyperliquid.gitbook.io/hyperliquid-docs/hypercore/multi-sig
  - ⚠️ The HyperEVM side remains controlled by the original key, and CoreWriter does not work for a multisig account.
- No native allowlist or withdrawal delay: **the only protection is the multisig threshold**.
- Withdrawals to Arbitrum: ~3–5 min, $1. The legacy bridge is deprecated; **CCTP is the preferred path**.
- Sub-accounts (no private key, traded via `vaultAddress`): under a multisig master, this is the recommended structure.
- Legacy HL vaults ($10k creation fee, leader ≥ 5%) are not recommended.
- Advanced alternative: **account held by an HyperEVM contract via CoreWriter**, which can add an API wallet (action 9). Withdrawal would then be restricted *by code* to a fixed destination. Safer in theory, but it is a recent pattern that requires a dedicated spike.

### 2.5 Stop-loss [V]
- TP/SL are trigger orders **stored on-chain on Hyperliquid**, triggered on the mark price, with 10% slippage for market orders. They remain active even if the keeper is offline (inference drawn from the fact that the order is on-chain).
- ⚠️ A child TP/SL is only placed if the parent order is **fully filled**.
- → The WarchestVault (on Robinhood Chain) **cannot enforce** the stop-loss. It can only store the parameter, and the keeper must place it on HL. The whitepaper must say so.

### 2.6 HL testnet [V]
- Faucet: `app.hyperliquid-testnet.xyz/drip`, 1,000 mock USDC, **the address must have already deposited on mainnet**.
- Testnet bridge on Arbitrum Sepolia: `0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89`.

---

## 3. Across bridge Robinhood Chain ↔ Hyperliquid (live API calls, 2026-09-27)

### 3.1 Routes [V]
- Across has been live on Robinhood Chain since 2026-07-06 (SpokePool `0xD29C85F15DF544bA632C9E25829fd29d767d7978`). — https://across.to/blog/bridge-to-robinhood-chain-with-across
- **No native Circle USDC on Robinhood Chain.** The routed stablecoin is **USDG** (Paxos) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- Routes to Hyperliquid:
  - Existing route: `4663 USDG → 999 (HyperEVM) USDC`, and the reverse return.
  - **No `4663 → 1337 (HyperCore)` route**: the API responds "No bridge routes found".
  - **ETH/WETH has no route to 999.**
- Route to HyperCore validated *from Arbitrum*: `42161 USDC → 1337 USDC-PERPS`, $100k → $99,986 (1.4 bp, ~8 s, via CCTP).
- → Candidate paths:
  - **A**: RH USDG → HyperEVM USDC (Across), then HyperEVM → HyperCore (transfer to the system address `0x2000…`).
  - **B**: RH USDG → Arbitrum USDC (Across), then Arbitrum → HyperCore USDC-PERPS (Across Swap API / CCTP). This path needs an intermediate address on Arbitrum.

### 3.2 Measured costs and delays (live quotes) [V]

| Direction | Amount | Cost | Estimated delay |
|---|---|---|---|
| RH USDG → HyperEVM USDC | $10k | ~6 bp (1 bp capital + 5 bp USDG→USDC swap) | ~2 s |
| RH → HyperEVM | $100k | ~6 bp | ~98 s |
| RH → HyperEVM | $500k | ~6 bp | ~900 s (above the $263k instant max) |
| HyperEVM → RH | $10k / $100k | 6 bp | 5 s / 27 s |
| HyperEVM → RH | $500k | **rejected** (`AMOUNT_TOO_HIGH`, max $278,572) | to be split |
| ETH RH → Arbitrum | — | — | instant max **~8.36 ETH** |

- These liquidity limits are a **snapshot**: they vary, and the keeper must query `/limits` every time.
- ⚠️ **Across has no testnet for Robinhood Chain or for Hyperliquid.** The Across testnet only covers Sepolia, Base, Arbitrum, OP, Amoy, Lens, Unichain and Solana Devnet.
- Do not use the canonical Orbit bridge for returns: it imposes a **7-day** challenge period.

### 3.3 Design consequences [I]
1. The hook collects ETH, so the vault must **swap ETH → USDG** on Robinhood Chain before bridging. **[V] Measured liquidity** (read-only quotes, block ~73.52M, 2026-09-27):

   | ETH sold | USDG received | Impact | Venue |
   |---|---|---|---|
   | 1 | 2,693.04 | ref. | Uniswap v3 0.01% `0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca` (TVL ≈ $19.6M) |
   | 10 | 26,928.34 | −0.01% | v3 0.01% |
   | 100 | 269,079.16 | −0.08% | v3 0.01% |
   | 500 | 1,343,266.66 | −0.24% | native-ETH v4 pool (id `0xbac3aa3b…e551`, hook `0x06a8…6080`) |

   - To test v3 quotes: QuoterV2 `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`.
   - The LiFi aggregator is slightly worse than the direct pools.
   - → Treasury-sized conversions cost < 0.5%. The vault will still have to bound slippage (`minOut`) and split large amounts.
2. The vault can enforce on-chain: amount ≤ 20%, **immutable recipient**, direct call to the Across SpokePool. This is a real guarantee.
3. The return to Robinhood requires a master signature (`withdraw3` or EVM transfer): **it cannot be automated by the agent**. This is intentional, and it is a safety feature.
4. For the testnet E2E, the bridge is **simulated**. Real bridge validation will be done on mainnet with small amounts, then treasury-sized amounts.

---

## 4. Real gas cost — MEASURED [V] (spike S0.1, 2026-09-27)

**Method:**
- Foundry fork of mainnet 4663 (block ~73,519,500), with the **real official v4 PoolManager**.
- Measurement via `gasleft()` around the call, with cold slots (`vm.cool`) for the benchmarks.
- L1 component (data publication) queried **live** via `NodeInterface.gasEstimateL1Component` (0x…C8), with random calldata, hence worst-case compression.
- Conversion: ETH = $2,694.68 (CoinGecko, same day). Live gas price = **0.025 gwei**, historical peak = **0.511 gwei**.
- Code: `research/spikes/` (reproducible: `./setup.sh && forge test -vv`).

### 4.1 Swap with the 10% fee hook (ETH/TOKEN pool, via PoolSwapTest)
| Case | Gas with hook | Gas without hook | Hook overhead | Fee sent to the vault |
|---|---|---|---|---|
| Buy exactIn 1 ETH | 189,144 | 143,954 | **45,190** | 0.1 ETH (exactly 10%) |
| Buy exactOut 1 TOKEN | 187,719 | 142,700 | **45,019** | 10% of the ETH paid |
| Sell exactIn 1 TOKEN | 178,989 | 134,024 | **44,965** | 10% of the gross ETH received |
| Sell exactOut 0.5 ETH | 179,692 | 134,544 | **45,148** | 0.05 ETH = 10% of the **net**, i.e. 9.09% of the gross ⚠️ |

- L1 component: ~371–456 gas for 700–900 bytes of calldata, negligible.
- **Cost of a swap with the hook: ~$0.013 at current gas, ~$0.26 at the peak.** The hook overhead is worth ~$0.003 ($0.06 at the peak).
- The overhead (~45k) mainly comes from the native ETH `take` to a cold vault address.
- ⚠️ **Semantics to settle in S1.3**: on a sell exactOut, taking 10% of the *specified* amount amounts to taking 9.09% of the gross. Prod will compute `fee = net × 1000 / 9000` to guarantee 10% of the gross in all 4 cases.

**Re-measurement with the production hook `WarchestHook` (S1.2, 2026-09-27, mainnet fork, `contracts/test/fork/`) [V].** Difference in method: each measurement starts from a cold state (`vm.cool` on PoolManager, hook, token, router, vault) and the hook already holds claims (steady state after a `flush()`), which reproduces a real transaction. Fees are minted as **ERC-6909 claims** to the hook (no native `take` during the swap), then a permissionless `flush()` to the vault.

| Case | Gas with hook | Gas without hook | Hook overhead |
|---|---|---|---|
| Buy exactIn 1 ETH | 155,059 | 109,506 | **45,553** |
| Buy exactOut 1 TOKEN | 161,779 | 113,113 | **48,666** |
| Sell exactIn 1 TOKEN | 148,008 | 117,359 | **30,649** |
| Sell exactOut 0.5 ETH | 155,540 | 129,954 | **25,586** |
| `flush()` (burn of the claims + ETH `take` to the vault, amortized over N swaps) | 78,351 | — | — |

→ The per-swap overhead is equivalent to the spike on buys and 14–20k lower on sells, without exposing the market to a reverting vault. Via the **official UniversalRouter** `0x8876…0904` (+ Permit2 for token input), a swap with the hook costs 150,634 (sell exactIn) to 152,933 (buy exactIn) gas, measured in `test/fork/WarchestHookRouterFork.t.sol`.

**Vault (S3.1, 2026-09-27, mainnet fork, `test/fork/WarchestVaultFork.t.sol`) [V].** `convertEthToUsdg(10 ETH)` cold (`vm.cool` on vault, v3 pool, WETH, USDG), direct swap against the v3 0.01% pool with a 30-min TWAP read: **304,012 gas** (≈ $0.02 at current gas, $0.42 at the peak). The output is identical to the official QuoterV2 quote for the same block.

**Vault (S3.2, 2026-09-27, mainnet fork, same test) [V].** `executeDecision` (reading the decision, 20% NAV cap with TWAP, `deposit(bytes32,…)` on the **real Across SpokePool** `0xD29C…7978` to HyperEVM 999) cold: **322,795 gas** (≈ $0.02 at current gas, $0.44 at the peak). The SpokePool's `FundsDeposited` event does carry the immutable recipient and `depositId = numberOfDeposits` (372,448 at block 73,587,135).

### 4.2 Governance: merkle root (D2) vs per-wallet writes
| Operation | Gas | Current cost | Peak cost |
|---|---|---|---|
| `submitRoot` (1 root per epoch, regardless of the number of holders) | 44,575 | $0.003 | $0.06 |
| `vote` with proof, depth 17 (≈100k holders) | 87,248 (+371 L1) | $0.006 | $0.12 |
| `vote` with proof, depth 20 (≈1M holders) | 89,770 | $0.006 | $0.12 |
| *Rejected:* `setLevels` 1,000 wallets (first write) | 23,171,534 | $1.56 | $31.95 |
| *Rejected:* `setLevels` 10,000 wallets (first write) | 233,617,623 | $15.76 **per day** | $322 **per day** |
| *Rejected:* `setLevels` 10,000 wallets (update) | 60,212,529 | $4.08/day | $83/day |

→ **D2 is confirmed by measurement.** The merkle root has a constant cost of ~$0.003 per epoch, whereas per-wallet writes cost from $4 to $322 per day for 10k holders.

Batches must additionally be split if ArbOS imposes a per-tx gas cap [I: 32M on Arbitrum, not verified for this chain]. For reference, the block `gasLimit` read live is 1.1e15.

### 4.2 bis Off-chain indexer at scale [V] (S4.4)
- 100,000 holders and ≈ 600,000 transfers:
  - LIFO snapshot: 2.2 s;
  - merkle tree: 19.3 s;
  - published dump: 29.4 MB;
  - proof depth: 17, i.e. a vote at ≈ 87k gas (§4.2).
- The on-chain cost stays constant (1 root per day).

### 4.3 On-chain lots (rejected alternative, measured to justify the off-chain choice)
| Operation (wallet with 500 small buys) | Gas | Current cost | Peak cost |
|---|---|---|---|
| Buy (push of 1 lot) | 67,012 | $0.005 | $0.09 |
| LIFO sell consuming 1 lot | 28,733 | $0.002 | $0.04 |
| **LIFO sell consuming 500 lots (worst case)** | 2,486,939 | $0.17 | $3.42 |
| FIFO sell consuming 500 lots | 2,406,020 | $0.16 | $3.31 |
| On-chain weight computation (scan of 500 lots) | 1,536,959 | $0.10 | $2.12 |

→ On-chain LIFO or FIFO remain **technically affordable** on this L2. But:
1. They would impose a variable gas tax on every transfer, and the token must remain a pure ERC20 (non-negotiable constraint).
2. A spam wallet (thousands of micro-lots received) would blow up the cost, which opens a griefing vector.

**Lot computation therefore stays off-chain (indexer), with an on-chain merkle root.**

---

## 5. Inconsistencies and gaps in the documents

1. **FIFO vs LIFO**: the whitepaper says "the most recently acquired tokens are sold first", which is **LIFO**. The plan says FIFO. LIFO matches the intent ("trimming a position does not destroy the seniority of the rest").
2. **Weight per lot**: with lots, the weight is `Σ lot.amount × level(lot)`, not `balance × level`. A wallet does not have "one" level.
3. **Double voting**: `live balance × level` allows voting, transferring, then voting again (cf. Beanstalk, $182M). A balance snapshot is required. → **Merkle root of weights per epoch**: O(1) on-chain cost, auditable, with a challenge window (Morpho URD pattern).
4. **Wallet → wallet transfers**: they must be treated as a sale for the sender (LIFO) and a level-0 lot for the receiver. The addresses to exclude (PoolManager, vault, contracts) remain to be defined.
5. **Quorum fallback**: "the previous decision stands" is ambiguous. If the previous position was stopped out, should it be reopened? To be specified.
6. **Distribution**: the whitepaper says "proportional to level", whereas the vote is `size × level`. No distribution contract is planned, nor any on-chain high-water mark mechanism, nor attested NAV. → To add: a **Distributor** (cumulative merkle) + a HWM in the vault.
7. **"Automatic" stop-loss in the vault**: impossible from Robinhood Chain (§2.5).
8. **Stakd**: wrong reference (§1.4).
9. **Testnet E2E**: impossible as is (§1.2 and §3.2).

---

## 6. Legal and audit

- **SEC**:
  - Statement on meme coins (2025-02-27): not securities *unless* there is an expectation of profit based on the efforts of others.
  - Joint SEC/CFTC interpretation 2026-03-17: it is the transaction that is analyzed, and ongoing "managerial efforts" tie the token to an investment contract.
  - Regulation Crypto Assets proposed on 2026-08-18: its safe harbor requires "completed" efforts, which will never be the case here.
  - Possible CFTC exposure (commodity pool, since the pool trades leveraged derivatives).
  - → **WARCHEST (common treasury + active keeper + profit distribution) meets Howey.**
- **EU**: the 2025 ESMA guidelines make a token that grants a share of the returns of a managed portfolio a **UCI (AIFMD)** or a **transferable security (MiFID II)**.
- Robinhood can block addresses (Terms of Service).
- → **Legal advice before mainnet.** Options: US/EU geo-blocking, or replacing distribution with buyback & burn (weaker argument under Howey, but not zero).
- **Audit**:
  - Budget ~$60–150k and 4–8 weeks, fix review included (Sherlock 2026 price reference).
  - **Uniswap Foundation Security Fund**: subsidizes v4 hook audits, with 22+ approved auditors. To be solicited.
  - The keeper and the bridge are not covered by a Solidity audit.
- **Precedents**:
  - JELLY/HLP (March 2025): venue risk on Hyperliquid.
  - Mango (2022): a governance can ratify a theft.
  - Compound Prop 289: capture by a whale.
  - ai16z: a "fund" token declared dead.

---

## 7. Pre-mainnet checklist (status)

| Item from the technical plan | Status |
|---|---|
| Hook: buy/sell direction in all pool states | [TO TEST] mainnet fork + testnet (self-deployed v4) |
| Worst-case FIFO/LIFO gas | **[V] measured**: 2.49M gas for 500 lots ($0.17; $3.42 at the peak). Stays off-chain (§4.3) |
| Indexer → governance batches at scale | **[V] measured**: merkle root at 44.6k gas per epoch, vote at 87k gas (§4.2) |
| HL agent without withdrawal enforced by the protocol | **[V] confirmed**. 2 actions [TO TEST] |
| Across: cost and delay on treasury amounts | **[V] live quotes** (§3.2). Real transfer [TO TEST] on mainnet, small amounts |
| Full E2E on testnet | Possible **with simulated bridge** only |
| Quorum fallback | To be specified (§5.5), then tested |
