import { brand } from "@/config/brand";

/** The wax seal (brand/logos/seal). Plain <img>: static SVGs, nothing for next/image to optimise. */
export function LogoMark({ size = 32 }: { size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/seal.svg" width={size} height={size} alt="" aria-hidden="true" />;
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/wordmark-bone.svg" height={22} width={103} alt={brand.name} className="h-[22px] w-auto" />
    </span>
  );
}
