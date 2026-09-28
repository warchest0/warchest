import type { SVGProps } from "react";

/** Small stroke icon set (24px grid, currentColor). Kept local to avoid an icon dependency. */
type P = SVGProps<SVGSVGElement>;

function Base({ children, ...p }: P) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...p}
    >
      {children}
    </svg>
  );
}

export const IconGauge = (p: P) => (
  <Base {...p}>
    <path d="M12 14l4-4" />
    <path d="M3.3 17a9 9 0 1 1 17.4 0" />
  </Base>
);
export const IconVote = (p: P) => (
  <Base {...p}>
    <path d="M9 12l2 2 4-4" />
    <path d="M5 7h14l-1 13H6L5 7z" />
    <path d="M8 7V4h8v3" />
  </Base>
);
export const IconVault = (p: P) => (
  <Base {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 8.5V7M12 17v-1.5M15.5 12H17M7 12h1.5" />
  </Base>
);
export const IconTrophy = (p: P) => (
  <Base {...p}>
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z" />
    <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
  </Base>
);
export const IconFlame = (p: P) => (
  <Base {...p}>
    <path d="M12 22c4 0 7-2.7 7-6.8 0-3.6-2.4-5.6-3.9-8.2-.6 1.9-1.6 3-2.9 3.6C12.7 7 11.5 4.3 9 2c.3 3.4-1.3 5.4-2.8 7.4C5 11 5 12.6 5 15.2 5 19.3 8 22 12 22z" />
  </Base>
);
export const IconArrowRight = (p: P) => (
  <Base {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Base>
);
export const IconExternal = (p: P) => (
  <Base {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Base>
);
export const IconShield = (p: P) => (
  <Base {...p}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
    <path d="M9 12l2 2 4-4" />
  </Base>
);
export const IconClock = (p: P) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Base>
);
export const IconCoins = (p: P) => (
  <Base {...p}>
    <ellipse cx="9" cy="7" rx="6" ry="3" />
    <path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7" />
    <path d="M9 18c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.6-2.4-2.9-5.5-3" />
  </Base>
);
export const IconChart = (p: P) => (
  <Base {...p}>
    <path d="M3 20h18" />
    <path d="M5 16l4-5 4 3 6-8" />
  </Base>
);
export const IconWallet = (p: P) => (
  <Base {...p}>
    <path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6" />
    <circle cx="16.5" cy="13.5" r="1.2" />
  </Base>
);
export const IconCheck = (p: P) => (
  <Base {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Base>
);
export const IconAlert = (p: P) => (
  <Base {...p}>
    <path d="M12 3l10 18H2L12 3z" />
    <path d="M12 10v5M12 18h.01" />
  </Base>
);
export const IconChevron = (p: P) => (
  <Base {...p}>
    <path d="M6 9l6 6 6-6" />
  </Base>
);
export const IconDownload = (p: P) => (
  <Base {...p}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </Base>
);
export const IconShare = (p: P) => (
  <Base {...p}>
    <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M7 8l5-5 5 5" />
  </Base>
);
export const IconSearch = (p: P) => (
  <Base {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </Base>
);
