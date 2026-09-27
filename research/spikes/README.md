# Spike S0.1 — real gas measurement (throwaway code)

Fork of **Robinhood Chain mainnet (4663)** with the **real v4 PoolManager** `0x8366…0951`.
Nothing here is production code.

```bash
./setup.sh
forge test -vv
```

- `src/SpikeFeeHook.sol`: minimal hook, 10% in ETH, to measure the overhead.
- `src/SpikeBench.sol`: merkle vote (D2), and the rejected alternatives (per-wallet levels, on-chain LIFO/FIFO lots).
- `test/Gas.t.sol`: the measurements. Results are reported in `RESEARCH.md` §4.
