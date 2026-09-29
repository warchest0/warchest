# Deploying the off-chain services

Docker images for the indexer and the keeper, orchestrated by `docker-compose.yml`. Each role runs under its own
profile so every key lives only on the machine that needs it.

| Profile | Services | Key held | Where |
|---|---|---|---|
| `indexer` | `indexer-publisher` (daily weight root at 00:20 UTC), `indexer-api` (port 8787, for the frontend) | governance `updater` | ops machine |
| `verifier` | `indexer-verifier` (rebuilds and checks the published root at 02:00 UTC, inside the challenge window) | none | **another** machine / operator |
| `keeper` | `keeper` (trading loop; `MODE=dry-run` until explicitly switched to `live`) | vault `keeper` EOA + Hyperliquid agent (trade-only) | keeper machine |
| `monitor` | `keeper-monitor` (independent checks, optional kill switch) | none, or the agent key with `MONITOR_KILL=1` | **another** machine |

```bash
cp indexer/.env.example deploy/indexer.env   # fill TOKEN, START_BLOCK, GOVERNANCE, EXCLUDED, UPDATER_PRIVATE_KEY
cp keeper/.env.example  deploy/keeper.env    # fill VAULT, GOVERNANCE, HL_ACCOUNT, ...
docker compose -f deploy/docker-compose.yml --profile indexer up -d --build
docker compose -f deploy/docker-compose.yml --profile keeper  up -d --build
```

- `deploy/*.env` files are git-ignored; never commit keys.
- Data (SQLite, published trees) lives in named volumes; back up `indexer-data` (the trees voters need).
- `daily.sh` schedules a command every day at `AT` (UTC); a failed run is logged and retried the next day — wire the
  alert webhooks (`ALERT_WEBHOOK_URL` in the keeper) and watch the verifier's exit status.
- For testnet, point `RPC_URL`/`CHAIN_ID` at 46630 and use the addresses from `contracts/deployments/46630.json`.
