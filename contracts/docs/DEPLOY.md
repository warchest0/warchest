# Deployment — token + hook + pool (S1.4)

Uniswap v4 is deployed **at the same addresses** on testnet (46630) and mainnet (4663). A single script covers both.

## Prerequisites
- A deployer key with testnet ETH. You need about 0.05 ETH for gas, plus `LP_ETH_AMOUNT`.
  - The deployer receives the entire supply, initializes the pool and owns the LP position.
- `WARCHEST_VAULT`: fee recipient, **immutable in the hook**.
  - On testnet, a temporary address can be used until the S3 vault is available.
  - On mainnet, the vault must be deployed **before** the hook, and must accept native ETH from anyone.

## Command
```bash
cd contracts
export WARCHEST_VAULT=0x...        # required
export LP_TOKEN_AMOUNT=...         # in wei, defaults to the entire supply
export LP_ETH_AMOUNT=...           # in wei, defaults to 1 ETH
forge script script/DeployWarchest.s.sol \
  --rpc-url robinhood_testnet --account <keystore> --broadcast \
  --verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```

The script runs, in order:
1. Deploys `WarchestToken`.
2. Mines the hook salt (flags `0x20CC`) and deploys it via CREATE2 (`0x4e59…956C`).
3. Calls `PoolManager.initialize` **directly**, at the price `LP_TOKEN_AMOUNT / LP_ETH_AMOUNT`.
4. Creates the full-range LP position via the official PositionManager (Permit2).

## Verified
- `test/fork/DeployWarchestFork.t.sol` replays the whole launch on a testnet fork and a mainnet fork. It then makes a 1 ETH buy, then `flush()`, and checks that the vault receives 0.1 ETH − 1 wei.
- `forge script … --broadcast` was also run against an anvil fork of the testnet, without errors.

## Pitfalls
- **Never** initialize the pool via the PositionManager's multicall: the hook requires `sender == initializer`.
- The pool is protected against a front-run of the initialization, since only `initializer` can call it. However, the **initial price** is the one chosen by the deployer, so double-check it.
- Hook allowlist: see `HOOKLIST.md`. Without validation, the Uniswap app and API do not route the pool.

---

# Full system deployment (S3.5)

`script/DeploySystem.s.sol` deploys and wires everything, in the only valid order:
1. Governance.
2. Distributor, if enabled.
3. Vault.
4. `governance.setVault`, then `setEligibleAssets` (BTC, ETH, SOL), then `distributor.setVault`.
5. Token, hook (whose fee recipient is the freshly deployed vault), pool and liquidity.
6. Initiation of the **guardian role transfer** to the multisig.

```bash
export GUARDIAN=0x...   # multisig
export UPDATER=0x...    # indexer
export KEEPER=0x...     # bot
export HL_ACCOUNT=0x... # Hyperliquid account (HL native multisig, D4) — IMMUTABLE in the vault
export ENABLE_DISTRIBUTOR=false   # D7: to be decided after the legal opinion
forge script script/DeploySystem.s.sol --rpc-url robinhood --account <keystore> --broadcast --verify
```

Once the script has finished, the multisig must call `acceptGuardian()` on the governance, the vault and the distributor.

Script safeguards (security review):
- The default values (v3 pool, WETH, USDG, SpokePool, HyperEVM USDC) exist only on mainnet **4663**: the script
  reverts with `WrongChain` on any other chain (a vault wired to these addresses elsewhere would be unusable, and
  its immutables cannot be fixed). Fork tests run on a mainnet fork, so they pass.
- **"Deployer = temporary guardian" window**: between deployment and the multisig's `acceptGuardian()` on the
  three contracts, the deployment key holds all the guardian's powers (pause, `setKeeper`, `revokeReport` /
  `revokeCloseReport`, `proposeUpdater` — delayed by 72 h on the governance side and by `timelock + 3 d` on the distributor side —,
  `cancelRound`, `setEligibleAssets`, cancelling its own transfer via a new `transferGuardian`) but can
  **never** move funds. Instructions: fresh deployment key, taken offline as soon as the script finishes;
  acceptance by the multisig **before** announcing the pool and before any treasury flow; check
  `guardian() == multisig` on all three contracts before the first conversion.

**Verified** by `test/fork/SystemCycleFork.t.sol`, on a fork of mainnet 4663 with the real v4 PoolManager, the real WETH/USDG v3 pool and the real Across SpokePool. The test runs through:
1. deployment and wiring;
2. a 20 ETH buy, which sends 2 ETH of fees to the vault;
3. conversion into ≈ 5,394 USDG at the TWAP price;
4. snapshot, vote, quorum, decision 1;
5. order ≤ 20% of NAV, with a real Across deposit;
6. round without quorum: the same id is kept, and nothing is executed (D8);
7. new decision: `mustClose` becomes true;
8. close, return of funds at +25%, PnL accounted for;
9. distributor funding, then claim.

Only the Hyperliquid leg and the bridge return fill are simulated. They will be covered in S5.

Test network:
- The PoolManager and the SpokePool are not a problem: v4 is present on 46630 and `MockAcrossSpokePool` replaces the SpokePool (D6).
- However, there is no WETH/USDG v3 pool on the testnet. The testnet E2E (S5.5) will therefore have to deploy a mock WETH/USDG pool with its oracle.

## Operations: oracle history depth (measured 2026-09-28)
The vault's oracle circuit breaker reads a 6-hour TWAP from the WETH/USDG Uniswap v3 pool. The pool stores a fixed number of observations (10,809), so the time they cover shrinks as trading activity grows: ≈ 44 h on 2026-09-27, ≈ 11 h on 2026-09-28. Below 6 h, `convertEthToUsdg` reverts (fail-closed: no funds at risk, but fees stay in ETH).

- Monitor: `POOL.observe([21600, 0])` must not revert with `OLD`.
- Extend ahead of need (permissionless, ≈ 22.4k gas per slot, ≈ $1.5 per 1,000 slots at 0.025 gwei):
  `TARGET_CARDINALITY=30000 forge script script/ExtendOracleHistory.s.sol --rpc-url robinhood --account <keystore> --broadcast`
