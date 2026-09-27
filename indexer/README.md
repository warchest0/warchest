# WARCHEST — indexer

Off-chain service (Node ≥ 24, TypeScript, viem, `node:sqlite`) that:
1. **indexes** the token's `Transfer`s up to the `finalized` block, and is therefore safe from reorgs (S4.1);
2. computes the **LIFO lots** and **levels** per daily UTC snapshot (S4.2);
3. builds the **weight merkle tree**, publishes it and pushes the root to `WarchestGovernance` (S4.3).

```bash
npm ci
npm test
```

## Robinhood Chain notes (measured)
- `eth_getLogs` returns `blockTimestamp = 0x0`. Timestamps are therefore fetched block by block, in batched JSON-RPC requests.
- The `finalized` tag is about 8,500 blocks (≈ 14 min) behind the chain head.
- Live throughput: 430 USDG transfers over 300 blocks, indexed in ≈ 1.1 s.

## Commands
Commands read their configuration from the environment (see `src/config.ts`).

| Command | Role |
|---|---|
| `npm run indexer sync` | Indexes finalized transfers |
| `npm run indexer snapshot [day]` | Writes the day's tree to `data/trees/<day>.json` (by default, the last complete day) |
| `npm run indexer publish [day]` | Builds the tree then calls `submitWeightRoot`. Restricted to the **updater**, idempotent. |
| `npm run indexer verify [day]` | **Independent second instance**: recomputes the tree and compares it to the on-chain root. Exit code 2 on mismatch; the guardian must then be alerted, as it can revoke during the challenge window. |
| `npm run indexer run` | Daily cron entry point, after 00:15 UTC, so that the previous day is finalized |

Environment variables:
- required: `TOKEN`, `START_BLOCK`, `GOVERNANCE`;
- optional: `RPC_URL`, `CHAIN_ID`, `EXCLUDED` (vault, hook and distributor addresses, comma-separated), `DB_PATH`, `OUT_DIR`, `UPDATER_PRIVATE_KEY`.

The v4 PoolManager, the token and the governance are always excluded.

## Tree format
- Leaves `(chainid, governance, epoch, account, weight)`, in OpenZeppelin `StandardMerkleTree` format. This is bit for bit identical to `WarchestGovernance.leaf`, and it is verified by an integration test on anvil.
- `treeHash = keccak256(canonical JSON dump)` is published on-chain together with the root.

## Scaling (S4.4, measured locally)
| Holders | Transfers | Snapshot | Tree | Dump | Proof depth |
|---|---|---|---|---|---|
| 10,000 | 59,824 | 0.16 s | 1.9 s | — | 14 |
| 100,000 | 598,492 | 2.2 s | 19.3 s | 29.4 MB (heap 396 MB) | 17 |

Constant on-chain cost, regardless of the number of holders: one `submitWeightRoot` per day (≈ 44.6k gas, i.e. ≈ $0.003). See RESEARCH §4.2.

Benchmark: `npm run bench [holders] [buys per holder]`.

## Distribution (D7 module)
`src/distribution.ts`:
- `addDistribution` splits each distributor funding pro rata to the snapshot weights. Shares are rounded down to the unit, so the distributed sum never exceeds the funded amount.
- `buildDistributionTree` produces the **cumulative** tree, with leaves identical to `WarchestDistributor.leaf`.
