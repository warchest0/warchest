# WarchestHook — design notes

Uniswap v4 hook (`contracts/src/WarchestHook.sol`) that takes **10% of the gross ETH** on every swap in the canonical
native ETH / WARCHEST pool and routes it to an immutable vault. No owner, no setter, nothing upgradeable: all
parameters are `constant` or `immutable`.

## 1. Pool and directions

- Native ETH = `address(0)` = `currency0`, WARCHEST = `currency1`.
- `zeroForOne == true` ⇔ **buy** (ETH in, WAR out); `false` ⇔ **sell**.
- `amountSpecified < 0` ⇔ exactIn; `> 0` ⇔ exactOut.
- ETH is the *specified* currency iff `(amountSpecified < 0) == zeroForOne`.

## 2. Fee definition and where it is taken

`fee = 10% of gross ETH`, gross being the total ETH the buyer pays out, or the ETH the pool pays to the seller.

| Case | Specified currency | Taken in | Formula | Returned delta |
|---|---|---|---|---|
| Buy exactIn | ETH | `beforeSwap` | user pays X; `fee = ⌈X/10⌉`; the pool receives `X − fee` | `BeforeSwapDelta(+fee, 0)` |
| Buy exactOut | WAR | `afterSwap` | the pool needs P; `fee = ⌈P/9⌉`; user pays `P + fee` | `int128(+fee)` (unspecified) |
| Sell exactIn | WAR | `afterSwap` | the pool pays G; `fee = ⌈G/10⌉`; user receives `G − fee` | `int128(+fee)` |
| Sell exactOut | ETH | `beforeSwap` | user wants X net; the pool must pay `X + fee`, `fee = ⌈X/9⌉` | `BeforeSwapDelta(+fee, 0)` |

`fee = P/9` (resp. `X/9`) is exactly equivalent to `fee = 10% × (P + fee)`: in all 4 cases the fee is indeed 10% of
gross, which fixes the asymmetry measured in spike S0.1 (9.09% of gross on sell exactOut).

Sign conventions (v4-core `Hooks.sol`): a **positive** delta returned by the hook is **credited to the hook** and
**debited from the swapper**. In `beforeSwap`, `amountToSwap = amountSpecified + delta`: for a buy exactIn (`−X + fee`)
the pool swaps less; for a sell exactOut (`X + fee`) the pool must pay out more. The hook therefore always returns
`+fee`. The PoolManager adds `fee` to the hook's delta, which the hook settles immediately by minting claims.

## 3. Rounding

All divisions round **up** (in favor of the vault). Bounds, valid in all 4 cases:

- `0 ≤ ⌈G/10⌉ − G/10 < 1`;
- with `fee = ⌈N/9⌉`: `fee − (N + fee)/10 = (9·fee − N)/10 ∈ [0, 0.8]`.

Hence **`0 ≤ fee − 10%·gross < 1 wei`** always, proven by fuzzing (`testFuzz_*_feeWithinOneWeiOf10Percent`,
`testFuzz_allFourCases_feeBound`) and by the invariant `invariant_feeIsTenPercentOfGross`.

Rounding up never breaks the swap: `⌈X/10⌉ ≤ X` for `X ≥ 1`, so the specified amount keeps its sign
and `HookDeltaExceedsSwapAmount` is impossible. Documented edge case: for a buy exactIn of less than 10 wei,
the whole amount is taken as fee and the pool swaps nothing (Pool.swap with a zero amount returns a zero delta).

## 4. Partial fills (`sqrtPriceLimitX96`, insufficient liquidity)

- **ETH specified (buy exactIn, sell exactOut)**: the fee is computed in `beforeSwap` on the *requested* amount. If
  the pool fills only part of it, the fee would exceed 10% of the realized amount, and on a sell exactOut the swapper could
  even end up *paying* ETH (`G' − fee < 0`). `afterSwap` therefore recomputes the expected amount (a pure function of
  `params`, no storage) and **reverts `PartialFill(expected, actual)`** if the pool's ETH delta differs.
  In practice: a buy exactIn or a sell exactOut on a pool with no liquidity, or with a price limit
  reached, reverts. Routers use extreme limits, so this only shows up when the pool cannot
  serve the request.
- **ETH unspecified (buy exactOut, sell exactIn)**: the fee is computed in `afterSwap` on the realized amount. The
  partial fill is allowed and charged exactly 10%.

Rejected alternative: refunding the difference in `afterSwap`. Impossible, because `afterSwap` can only adjust the
delta of the *unspecified* currency (WAR in these cases), not ETH.

## 5. Fee delivery: ERC-6909 claims + `flush()`

On each swap, the fee is **minted as ERC-6909 claims** (id 0 = ETH) to the hook, with no external call. `flush()`,
**permissionless**, `unlock`s the PoolManager, burns the claims and `take`s the ETH to `vault`.

Why not a direct `take` to the vault during the swap:
1. **DoS**: a vault that reverts on receipt (guardian pause, broken proxy, missing `receive`) would block every
   swap in the market. With claims, only `flush()` fails; swaps continue.
2. **Reentrancy**: no third-party contract is called while the PoolManager is unlocked.
3. **Gas**: minting claims ≈ SLOAD + non-zero→non-zero SSTORE + log, cheaper than a native transfer to a cold
   address. `flush()` is amortized over N swaps.

`flush()` leaves **1 wei** of claims so that the balance slot never goes back to zero (≈ 17k gas saved on the
next swap). `pendingFees()` includes this wei. Reentering `flush()` from the vault is harmless: the PoolManager is
already unlocked (`AlreadyUnlocked`) and the claims have already been burned, so the inner call reverts.

Consequence for the vault (S3): it must **accept native ETH at any time**, from any caller.

## 6. Initialization

`beforeInitialize` only accepts:
- `sender == initializer` (immutable) — prevents a front-run initialization at a manipulated price;
- `currency0 == ETH` and `currency1 == token`;
- static LP fee (no `DYNAMIC_FEE_FLAG`);
- **only once**: `poolId` is stored, any second pool reverts `PoolAlreadyInitialized`.

⚠️ `initializer` must call `PoolManager.initialize` **directly**. Through the PositionManager's multicall, the
`sender` seen by the hook would be the PositionManager.

## 7. Address and deployment

Flags encoded in the address: `beforeInitialize | beforeSwap | afterSwap | beforeSwapReturnDelta |
afterSwapReturnDelta` = `0x20CC`. `script/DeployWarchestHook.s.sol` mines the salt (`script/utils/HookMiner.sol`) and
deploys via the CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, present on Robinhood Chain. Tested on a
mainnet fork (`test/fork/WarchestHookFork.t.sol`).

## 8. Router compatibility

Tested with `PoolSwapTest` (v4-core), v4-periphery's `V4Router` (single-hop, multi-hop exactIn/exactOut, slippage)
and the **official UniversalRouter** `0x8876…0904` + Permit2 on a mainnet fork, for all 4 cases.

- The fee is visible to the routers' slippage protection (`amountOutMinimum`, `amountInMaximum`) and to the
  v4 Quoter, which simulates the swap through the PoolManager, hook included.
- The pinned `V4Router` reverts `V4ExactOutputUnfilled` if the realized output is below the request; with the
  hook, the delta returned by `PoolManager.swap` is indeed `X` net on sell exactOut, so no false positive.

## 9. Known limitations

- **Uniswap hook allowlist**: a hook with `*ReturnsDelta` is not routed by the Uniswap app or API until it
  is validated on the hook allowlist (verified source required). Application to be prepared in S1.4; 10% `TaxHook`s
  have already been accepted on Robinhood Chain.
- Buy exactIn / sell exactOut swaps **revert** on partial fill (§4) instead of being served
  partially.
- Buys of less than 10 wei: everything goes to fees (§3).
- `flush()` depends on a caller (keeper, or anyone). Without a call, fees stay as claims on the hook, with no
  loss.
- The hook has no `receive`: it cannot hold ETH. ERC-6909 claims can be *gifted* to it by a
  third party (`transfer`); they will simply end up in the vault on the next `flush()`.
- A single pool, with a static LP fee chosen by the initializer at deployment (S1.4).
