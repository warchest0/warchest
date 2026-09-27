/**
 * Hyperliquid tick/lot rules (docs "Tick and lot size"):
 * - prices: at most 5 significant figures AND at most `MAX_DECIMALS − szDecimals` decimals (MAX_DECIMALS = 6 for perps);
 *   integer prices are always allowed;
 * - sizes: rounded to `szDecimals`.
 * Everything is done in decimal strings, never in binary floats, so a wire value is exactly what we computed.
 */

const PERP_MAX_DECIMALS = 6;

/** Decimal string → { mantissa, exponent } (value = mantissa × 10^exponent). Only non-negative inputs. */
function parseDecimal(s: string): { mantissa: bigint; exponent: number } {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid decimal ${s}`);
  const [int, frac = ""] = s.split(".");
  return { mantissa: BigInt(int + frac), exponent: -frac.length };
}

export function formatDecimal(mantissa: bigint, exponent: number): string {
  if (mantissa < 0n) throw new Error("negative");
  if (exponent >= 0) return (mantissa * 10n ** BigInt(exponent)).toString();
  const digits = mantissa.toString().padStart(-exponent + 1, "0");
  const cut = digits.length + exponent;
  const out = `${digits.slice(0, cut)}.${digits.slice(cut)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

/** Truncates `s` to `decimals` decimal places (toward zero). */
export function truncateDecimals(s: string, decimals: number): string {
  const { mantissa, exponent } = parseDecimal(s);
  if (-exponent <= decimals) return formatDecimal(mantissa, exponent);
  const drop = -exponent - decimals;
  return formatDecimal(mantissa / 10n ** BigInt(drop), -decimals);
}

/** Rounds `s` to `decimals` decimal places, toward `dir`. */
export function roundDecimals(s: string, decimals: number, dir: "down" | "up"): string {
  const { mantissa, exponent } = parseDecimal(s);
  if (-exponent <= decimals) return formatDecimal(mantissa, exponent);
  const div = 10n ** BigInt(-exponent - decimals);
  let m = mantissa / div;
  if (dir === "up" && mantissa % div !== 0n) m += 1n;
  return formatDecimal(m, -decimals);
}

/** Valid perp price for `szDecimals`, rounded toward `dir` (a buy limit rounds up, a sell limit rounds down, etc.). */
export function roundPrice(px: string, szDecimals: number, dir: "down" | "up"): string {
  const maxDecimals = PERP_MAX_DECIMALS - szDecimals;
  const capped = roundDecimals(px, maxDecimals, dir);
  const { mantissa, exponent } = parseDecimal(capped);
  const digits = mantissa.toString().replace(/^0+/, "");
  const sig = digits.length;
  const intDigits = Math.max(0, digits.length + exponent);
  // integer prices are always allowed; otherwise 5 significant figures max
  if (sig <= 5 || exponent >= 0) return capped;
  const allowedDecimals = Math.max(0, 5 - intDigits);
  return roundDecimals(capped, Math.min(allowedDecimals, maxDecimals), dir);
}

/** Valid perp size for `szDecimals`, truncated (never rounds a size up). */
export function roundSize(sz: string, szDecimals: number): string {
  return truncateDecimals(sz, szDecimals);
}

/** Exact decimal arithmetic helpers on strings (non-negative). */
export function mulBps(s: string, bps: number): string {
  const { mantissa, exponent } = parseDecimal(s);
  return formatDecimal(mantissa * BigInt(bps), exponent - 4);
}

export function divDecimals(a: string, b: string, scale = 12): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (y.mantissa === 0n) throw new Error("division by zero");
  const num = x.mantissa * 10n ** BigInt(scale + Math.max(0, x.exponent - y.exponent));
  const den = y.mantissa * 10n ** BigInt(Math.max(0, y.exponent - x.exponent));
  return formatDecimal(num / den, -scale);
}

export function cmpDecimals(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const e = Math.min(x.exponent, y.exponent);
  const xm = x.mantissa * 10n ** BigInt(x.exponent - e);
  const ym = y.mantissa * 10n ** BigInt(y.exponent - e);
  return xm < ym ? -1 : xm > ym ? 1 : 0;
}

export function absDecimal(s: string): string {
  return s.startsWith("-") ? s.slice(1) : s;
}

/** USDC amount (6 decimals) → decimal string. */
export const usd6ToDecimal = (x: bigint): string => formatDecimal(x, -6);
/** Decimal string → USDC amount (6 decimals), truncated. */
export const decimalToUsd6 = (s: string): bigint => {
  const { mantissa, exponent } = parseDecimal(truncateDecimals(absDecimal(s), 6));
  return mantissa * 10n ** BigInt(6 + exponent);
};
