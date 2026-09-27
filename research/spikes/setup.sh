#!/usr/bin/env bash
# Reinstalls spike dependencies (lib/ is gitignored).
set -euo pipefail
cd "$(dirname "$0")"
forge install --no-git forge-std=foundry-rs/forge-std Uniswap/v4-core OpenZeppelin/openzeppelin-contracts
