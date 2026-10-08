# Brand and pre-launch kit

Logo directions and teaser videos for the pre-launch campaign on X. Open `index.html` in a browser to see everything on one page.

Everything is drawn in code (SVG, HTML and [Remotion](https://www.remotion.dev)), so every asset can be regenerated and edited.

## Logos

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
