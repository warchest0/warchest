# Audit request — draft (S1.5)

**Target**: Uniswap Foundation Security Fund, which can subsidize v4 hook audits. See https://www.uniswapfoundation.org/blog/proactive-security-for-uniswap-v4-builders
**To be sent by the project owner.** Nothing has been submitted automatically.

## Phase 1 scope
| File | Role |
|---|---|
| `src/WarchestHook.sol` | 10% ETH fee hook (≈ 260 lines) |
| `src/WarchestToken.sol` | Plain ERC20 (≈ 25 lines) |
| `script/DeployWarchest.s.sol`, `script/DeployWarchestHook.s.sol`, `script/utils/HookMiner.sol` | Launch |

Governance and the vault will be covered in a second wave, after S2 and S3.

## Priority review points
1. Signs of the `BeforeSwapDelta` and `int128` return values in the 4 buy/sell × exactIn/exactOut cases.
2. `feeOnNet = ceil(net/9)` formula and rounding (bound proven by fuzzing: 0 ≤ fee − 10%·gross < 1 wei).
3. Revert policy on `PartialFill`.
4. Permissionless `flush()`: reentrancy from the vault, and 1 wei deliberately retained.
5. `beforeInitialize` restriction.

## Tests
72+ tests:
- unit;
- fuzz over the 4 cases;
- 7 stateful invariants;
- fork tests against the real PoolManager and UniversalRouter on mainnet 4663.

Gas measurements in `RESEARCH.md` §4.1.
