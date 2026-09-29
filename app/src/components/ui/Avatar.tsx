import { shortAddr } from "@/lib/format";
import { cx } from "./primitives";

/** Deterministic gradient avatar derived from the address bytes (no external identicon dependency). */
export function Avatar({ address, size = 28, className }: { address: string; size?: number; className?: string }) {
  const h = address.toLowerCase().replace(/^0x/, "").padEnd(12, "0");
  const a = Number.parseInt(h.slice(0, 4), 16) % 360;
  const b = (a + 60 + (Number.parseInt(h.slice(4, 8), 16) % 120)) % 360;
  const angle = Number.parseInt(h.slice(8, 12), 16) % 360;
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block shrink-0 rounded-full ring-1 ring-white/10", className)}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(${angle}deg, hsl(${a} 80% 62%), hsl(${b} 75% 45%))`,
      }}
    />
  );
}

export function AddressLabel({ address, you }: { address: string; you?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar address={address} size={22} />
      <span className="num truncate text-sm">{shortAddr(address)}</span>
      {you && <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">YOU</span>}
    </span>
  );
}
