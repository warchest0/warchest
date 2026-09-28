import { formatUnits } from "viem";

export const TOKEN_DECIMALS = 18;
export const USD_DECIMALS = 6;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function toNumber(v: bigint, decimals: number): number {
  return Number(formatUnits(v, decimals));
}

/** USDG / USDC amounts (6 decimals). */
export function fmtUsd(v: bigint, opts: { cents?: boolean; sign?: boolean } = {}): string {
  const n = toNumber(v, USD_DECIMALS);
  const s = (opts.cents || Math.abs(n) < 1000 ? usd2 : usd0).format(Math.abs(n));
  const sign = n < 0 ? "−" : opts.sign && n > 0 ? "+" : "";
  return `${sign}${s}`;
}

export function fmtUsdCompact(v: bigint): string {
  const n = toNumber(v, USD_DECIMALS);
  return `${n < 0 ? "−" : ""}$${compact.format(Math.abs(n))}`;
}

export function fmtToken(v: bigint, decimals = TOKEN_DECIMALS): string {
  const n = toNumber(v, decimals);
  return n >= 100_000 ? compact.format(n) : int.format(n);
}

/** Voting weight is token base units × level: shown in token units ("level-tokens"). */
export function fmtWeight(v: bigint): string {
  return compact.format(toNumber(v, TOKEN_DECIMALS));
}

export function fmtEth(v: bigint): string {
  return `${toNumber(v, 18).toLocaleString("en-US", { maximumFractionDigits: 3 })} ETH`;
}

export function fmtBps(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

export function fmtPct(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(ss).padStart(2, "0")}s`;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [h, m, ss].map((x) => String(x).padStart(2, "0")).join(":");
}

export function fmtAgo(tsSec: number, nowSec: number): string {
  const d = Math.max(0, nowSec - tsSec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

export function fmtDate(tsSec: number): string {
  return new Date(tsSec * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
