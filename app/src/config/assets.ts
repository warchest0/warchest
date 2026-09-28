/**
 * Hyperliquid perp asset indices (position in the `meta.universe` array) → display metadata. Governance stores raw
 * indices; the deployment default eligible list is BTC (0), ETH (1), SOL (5). Unknown indices fall back to `#index`.
 */
export interface AssetMeta {
  symbol: string;
  name: string;
  /** Hue used for the asset badge. */
  color: string;
}

const KNOWN: Record<number, AssetMeta> = {
  0: { symbol: "BTC", name: "Bitcoin", color: "#f7931a" },
  1: { symbol: "ETH", name: "Ether", color: "#8c9eff" },
  5: { symbol: "SOL", name: "Solana", color: "#14f195" },
  7: { symbol: "BNB", name: "BNB", color: "#f3ba2f" },
  12: { symbol: "DOGE", name: "Dogecoin", color: "#c2a633" },
  159: { symbol: "HYPE", name: "Hyperliquid", color: "#50d2c1" },
};

export function assetMeta(index: number): AssetMeta {
  return KNOWN[index] ?? { symbol: `#${index}`, name: `Perp #${index}`, color: "#8c93a8" };
}
