# Brand and pre-launch kit

Logo directions and teaser videos for the pre-launch campaign on X. Open `index.html` in a browser to see everything on one page.

Everything is drawn in code (SVG, HTML and [Remotion](https://www.remotion.dev)), so every asset can be regenerated and edited.

## Chosen mark: the seal

The wax seal is the Warchest mark. Everything lives in `logos/seal/`:

| File | Use |
|---|---|
| `png/avatar-1024.png`, `png/avatar-400.png` | X profile picture (dark variant: `avatar-1024-dark.png`) |
| `png/x-banner-1500x500.png` | X header (dark variant: `x-banner-1500x500-dark.png`) |
| `png/og-1200x630.png` | Link preview for the site |
| `png/favicon-16.png`, `png/favicon-32.png`, `png/apple-touch-icon-180.png` | Site icons |
| `png/seal-2048.png`, `png/seal-flat-1024.png`, `png/lockup-ink-2400.png` | Transparent masters |
| `svg/seal.svg` | Full colour mark |
| `svg/seal-flat.svg` | Two colours, no relief (small sizes, print) |
| `svg/seal-mono-ink.svg`, `svg/seal-mono-bone.svg` | One colour, lettering knocked out (stamps, embossing) |
| `svg/seal-icon.svg` | Simplified mark for 16–32 px |
| `svg/wordmark-*.svg`, `svg/lockup-*.svg` | "Warchest" wordmark, alone and next to the seal |

All SVG lettering is outlined, so the files render the same everywhere without fonts. Colours: wax `#a3221b`, bone `#ece4d2`, ink `#0f0e0c`. Type: UnifrakturCook (wordmark), JetBrains Mono (ring and taglines), Anton (video headlines), all under the SIL Open Font License and bundled in `logos/seal/fonts/`.

Regenerate: `cd brand/logos && npm ci && node seal/build.mjs` (preview: `logos/seal/sheet.png`).

The kinetic videos (`05`–`08`, `t-7`…`t-1`) use the seal palette and end on the seal being pressed onto the page.

## Other directions explored

| Folder | Direction |
|---|---|
| `logos/v3/` | **Terminal** (recommended): `warchest` drawn on a grid with an amber cursor, dot-matrix lettering, four pixel icons (chest, ranks, `[w]`, walker), X profile and site mockups |
| `logos/v2/` | **Street**: stencil, wax seal, pixel chest, gothic, rank patch, poster — each shown in a real-world mockup |
| `logos/v1/` | First round: six geometric marks on navy |

Each folder holds `svg/` (vector files), `png/` (1024 px avatars) and, for v2 and v3, `sheets/` (presentation boards).

Regenerate:

```bash
cd brand/logos && npm ci && npx playwright install chromium
cd v3 && node build.mjs
```

## Videos

| Composition | Length | Content |
|---|---|---|
| `09-boot` | 9.5 s | The system boots, the rules come online, a live log scrolls, the wordmark draws itself |
| `10-siege-log` | 9 s | Price falls through −30% from ATH, Siege arms, sells are bought back and burned |
| `11-rank-up` | 9 s | A holder goes from day 0 to day 10, Recruit to Warlord |
| `05-manifesto` … `08-sellers-pay` | 6–8 s | Fast kinetic-type cuts |
| `t-7` … `t-1` | 4 s | Daily countdown posts |
| `01-the-chest` … `04-earn` | 11–12 s | First round, cinematic |

Every composition also exists as `<id>-vertical` (1080 × 1920) for TikTok, Reels and Shorts. Only the terminal teasers are versioned in `videos/out/terminal/`; render the others from source:

```bash
cd brand/videos && npm ci
npx remotion studio                                   # live preview
npx remotion render src/index.ts 05-manifesto out/hype/05-manifesto.mp4 --codec=h264 --crf=18
```

Sources: `videos/src/terminal.tsx` (terminal teasers), `videos/src/hype.tsx` (kinetic cuts and countdown), `videos/src/teasers.tsx` (first round).

Figures shown on screen (burned amounts, ETH, addresses) are marked as illustrations. They are not live data. The videos are silent.
