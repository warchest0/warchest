# WARCHEST — contracts

Foundry. Dependencies as submodules (pinned versions):
- `v4-core` `d153b04` (`src/` source identical to npm release 1.0.2; this is the revision pinned by `uniswap-hooks` v1.2.1, whose `BaseHook` imports `types/PoolOperation.sol`, absent from the `v4.0.0` tag)
- `v4-periphery` `9969eec` (main, `V4Router`, reference `HookMiner`)
- `openzeppelin-contracts` v5.7.0
- `uniswap-hooks` v1.2.1

```bash
git submodule update --init --recursive
cp .env.example .env   # Robinhood Chain RPC (fork tests)
forge test                                   # unit tests (local PoolManager); fork tests are skipped without ROBINHOOD_RPC_URL
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/fork/*" -vv   # mainnet 4663 fork, real PoolManager
```

| Contract | Role |
|---|---|
| `WarchestToken` | Plain ERC20, fixed supply, **zero tax** |
| `WarchestHook` | v4 hook: 10% of gross ETH on every swap, as ERC-6909 claims, permissionless `flush()` to the immutable vault |

## WarchestHook (S1.2 + S1.3) — detailed design in [`docs/HOOK.md`](docs/HOOK.md)
- Single native ETH / WAR pool, initializable **only once** and **only by the `initializer` address** (immutable), which must call `PoolManager.initialize` directly.
- Fee = 10% of gross ETH in all 4 cases (buy/sell × exactIn/exactOut), rounded up to the wei in favor of the vault (`|fee − 10%| < 1 wei`).
- ETH specified (buy exactIn, sell exactOut) → taken in `beforeSwap`; ETH unspecified → in `afterSwap`. A partial fill of a swap charged in `beforeSwap` reverts (`PartialFill`).
- Delivery: ERC-6909 claims minted to the hook (no external call during the swap, a reverting vault does not block the market), then `flush()` → `vault`. `flush()` leaves 1 wei of claims (non-zero slot, saves ~17k gas on the next swap).
- No owner, no setter, nothing upgradeable.

Tests: `test/WarchestHook.t.sol` (unit, exactIn), `test/WarchestHookExactOut.t.sol` (exactOut, partial fills, zero liquidity, multi-tick, extreme amounts, fuzzing of the 4 cases), `test/WarchestHookRouter.t.sol` (v4-periphery `V4Router`, multi-hop, slippage), `test/invariant/` (stateful invariants: fee conservation, 10% ± 1 wei, settled deltas, constant supply), `test/fork/` (real PoolManager, UniversalRouter + Permit2, deployment script).

## Deployment (script ready for S1.4)
```bash
export POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951 WARCHEST_TOKEN=... WARCHEST_VAULT=... POOL_INITIALIZER=...
forge script script/DeployWarchestHook.s.sol --rpc-url robinhood_testnet --broadcast --verify
```
The script mines a salt (`script/utils/HookMiner.sol`) and deploys via the CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` so that the address encodes the flags `beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta | afterSwapReturnDelta` (`0x20CC`). Tested on a mainnet fork (`test/fork/`).

## Full launch (S1.4)
`script/DeployWarchest.s.sol`: token, hook, pool initialization and full-range liquidity, in a single script (testnet and mainnet). Runbook: `docs/DEPLOY.md`. Applications: `docs/HOOKLIST.md`, `docs/AUDIT-REQUEST.md`.

## Governance (branch 2)
`src/WarchestGovernance.sol` + `src/interfaces/IWarchestDecisionSource.sol`. See `docs/GOVERNANCE.md`.
