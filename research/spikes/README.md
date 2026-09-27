# Spike S0.1 — mesure de gas réelle (code jetable)

Fork du **mainnet Robinhood Chain (4663)** avec le **vrai PoolManager v4** `0x8366…0951`.
Rien ici n'est du code de production.

```bash
./setup.sh
forge test -vv
```

- `src/SpikeFeeHook.sol` : hook minimal, 10 % en ETH, pour mesurer l'overhead.
- `src/SpikeBench.sol` : vote merkle (D2), et les alternatives rejetées (levels par wallet, lots on-chain LIFO/FIFO).
- `test/Gas.t.sol` : les mesures. Les résultats sont reportés dans `RESEARCH.md` §4.
