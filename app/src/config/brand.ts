/**
 * Single source of truth for everything brand-related. The project name, ticker and colors are NOT final:
 * change them here and nowhere else. No other file may hard-code the project name.
 */
export const brand = {
  /** Display name, e.g. in the nav, titles and copy. */
  name: "Warchest",
  /** Token ticker, without the `$`. */
  ticker: "WAR",
  tagline: "Hold longer. Rank higher.",
  description:
    "Every trade fills a shared chest. Every day you hold, you rank up. The higher your rank, the bigger your share of what the chest earns.",
  /** Public links; leave empty to hide. */
  links: {
    github: "https://github.com/warchest0/warchest",
    x: "",
    docs: "/docs.html",
  },
  /**
   * Colors are injected as CSS variables on <html> (see `brandCssVars`) and mapped to Tailwind tokens in
   * `globals.css`, so a rebrand is a one-file change.
   */
  colors: {
    /** Primary accent: CTAs, focus rings, highlights. */
    accent: "#e0503c",
    /** Secondary accent: level ring gradient end, charts. */
    accent2: "#a3221b",
    /** Streak / warm highlight. */
    warm: "#d9a441",
    long: "#7fb069",
    short: "#e0503c",
    /** App background and surfaces (dark theme): ink, with bone text. */
    bg: "#0f0e0c",
    surface: "#181613",
    surface2: "#221f1b",
    border: "#36312a",
    text: "#ece4d2",
    muted: "#a59c8b",
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
