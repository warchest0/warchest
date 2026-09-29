/**
 * Single source of truth for everything brand-related. The project name, ticker and colors are NOT final:
 * change them here and nowhere else. No other file may hard-code the project name.
 */
export const brand = {
  /** Display name, e.g. in the nav, titles and copy. */
  name: "Warchest",
  /** Token ticker, without the `$`. */
  ticker: "WAR",
  tagline: "Hold longer. Vote heavier. Trade together.",
  description:
    "Every trade funds a shared treasury. Every day you hold makes your vote count more. Holders decide what the treasury trades on Hyperliquid.",
  /** Public links; leave empty to hide. */
  links: {
    github: "https://github.com/warchest0/warchest",
    x: "",
    docs: "https://github.com/warchest0/warchest#readme",
  },
  /**
   * Colors are injected as CSS variables on <html> (see `brandCssVars`) and mapped to Tailwind tokens in
   * `globals.css`, so a rebrand is a one-file change.
   */
  colors: {
    /** Primary accent: CTAs, focus rings, highlights. */
    accent: "#7cf5c6",
    /** Secondary accent: level ring gradient end, charts. */
    accent2: "#9b8cff",
    /** Streak / warm highlight. */
    warm: "#ffb454",
    long: "#34d399",
    short: "#fb7185",
    /** App background and surfaces (dark theme). */
    bg: "#07080b",
    surface: "#0e1015",
    surface2: "#151821",
    border: "#232735",
    text: "#eef1f7",
    muted: "#8c93a8",
  },
} as const;

export type Brand = typeof brand;

/** `$WAR`-style ticker label. */
export const tickerLabel = `$${brand.ticker}`;

/** CSS custom properties consumed by `globals.css`. */
export function brandCssVars(): Record<string, string> {
  const c = brand.colors;
  return {
    "--brand-accent": c.accent,
    "--brand-accent-2": c.accent2,
    "--brand-warm": c.warm,
    "--brand-long": c.long,
    "--brand-short": c.short,
    "--brand-bg": c.bg,
    "--brand-surface": c.surface,
    "--brand-surface-2": c.surface2,
    "--brand-border": c.border,
    "--brand-text": c.text,
    "--brand-muted": c.muted,
  };
}
