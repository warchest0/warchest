#!/bin/sh
# Runs "$@" every day at HH:MM UTC (default 00:20, once the previous UTC day is finalized on-chain).
# Usage: daily.sh <command...>   env: AT=00:20
set -eu
AT="${AT:-00:20}"
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%F) $AT" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  echo "next run at $(date -u -d "@$next" '+%F %T') UTC"
  sleep $((next - now))
  "$@" || echo "run failed (will retry tomorrow; check alerts)" >&2
done
