import { assetMeta } from "@/config/assets";
import { Side, sideLabel } from "@/lib/options";
import { Badge } from "./primitives";

export function AssetDot({ asset, size = 20 }: { asset: number; size?: number }) {
  const m = assetMeta(asset);
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full text-[9px] font-bold text-bg"
      style={{ width: size, height: size, background: m.color }}
    >
      {m.symbol.slice(0, 1)}
    </span>
  );
}

export function AssetTag({ asset, side }: { asset: number; side?: Side }) {
  const m = assetMeta(asset);
  return (
    <span className="inline-flex items-center gap-2">
      <AssetDot asset={asset} />
      <span className="font-medium">{m.symbol}</span>
      {side !== undefined && <SideBadge side={side} />}
    </span>
  );
}

export function SideBadge({ side }: { side: Side }) {
  return <Badge tone={side === Side.Long ? "long" : "short"}>{sideLabel(side)}</Badge>;
}
