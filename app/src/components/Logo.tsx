import { brand } from "@/config/brand";

/** Placeholder brand mark: three rising bars (levels) in a rounded tile. Swap freely once the brand is final. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-accent)" />
          <stop offset="1" stopColor="var(--color-accent-2)" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#logo-g)" />
      <rect x="8" y="17" width="4" height="7" rx="2" fill="var(--color-bg)" />
      <rect x="14" y="12.5" width="4" height="11.5" rx="2" fill="var(--color-bg)" />
      <rect x="20" y="8" width="4" height="16" rx="2" fill="var(--color-bg)" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight">{brand.name}</span>
    </span>
  );
}
