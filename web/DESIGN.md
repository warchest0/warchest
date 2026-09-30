# Warchest website — reference study, 2026-09-29

Read: root README, instructions, RESEARCH, STATUS, DECISIONS, PLAN, both PDFs and whitepaper errata; governance/vault documentation; indexer API and lot implementation; keeper architecture and execution flow.

References inspected in a real Chromium browser at 1440 × 1000:
- https://ethena.fi/: near-black background (#05070b), pale blue typography, rounded glass navigation, atmospheric planetary horizon, spacious centered typography, illuminated metallic CTAs.
- https://cybermap.kaspersky.com/: rotating geographical globe, luminous moving arcs, sparse monospace telemetry, view and zoom controls. Reimplement the visual grammar with original Canvas geometry, without reusing its scripts or data feeds.
- https://onramper.com/: “Meet your users where they are. Every time.” section: oversized left-aligned typography, light lavender surface, segmented control, searchable geographical interaction and blue globe. Adapt into the protocol's capital journey and a blue geographical scene.

Implementation: original static frontend, native ES modules, CSS and Canvas, with no runtime dependencies. English matches the project's public whitepaper. Local geographic polygons from the public Natural Earth dataset mirrored by D3 Graph Gallery: https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson . Natural Earth data is public domain: https://www.naturalearthdata.com/about/terms-of-use/ . No copied company logos or proprietary source. Earth photography: NASA Visible Earth via the three.js example asset, credit in assets/README.md.

Product truth: prelaunch, not deployed, external audit pending. No fictional TVL, PnL, active votes, token contract or wallet transactions. Preview panel exposes protocol rules and the actual development status. Map is explicitly a conceptual visualization, not holder geolocation. Governance calculator uses whole UTC days, level 0 on acquisition, maximum 10, LIFO sales. Distribution remains an undecided module (D7). Cap is maximum 20%, not an investment return. Use technical docs as canonical over the outdated public PDF.

Motion: slow globe rotation, drifting orbit particles, scroll reveals, interactive route selection, pause and zoom, reduced-motion support. Pause rendering offscreen and in hidden tabs. All assets self-hosted.

## Second edition — feedback: not fluid, too formulaic

Replaced the split green hero with a photographic Earth horizon, desaturated blue palette and a locally hosted Inter variable font. Removed duplicated metrics, three-card feature layout, decorative coordinates and repeated telemetry headings. Protocol mechanics now use three editorial rows; source links are concise horizontal entries. The original blue geographical reference remains in the treasury chapter.

WebGL renders each sphere in a single fullscreen draw, rather than projecting thousands of geographical points on the main thread each frame. Geographic polygons rasterize once into a texture; rotation and zoom ease toward their targets. Offscreen, hidden, paused and reduced-motion scenes stop requesting frames. Canvas fallback retained for browsers without WebGL; GPU context loss shows a static scene.

Local Chromium measurement, 1440×1000, 3.5 seconds: old draw median 6.2 ms / p95 7.2 ms; new JavaScript draw median below timer resolution / p95 0.1 ms. This measures CPU submission only, not GPU frame time or a guaranteed device FPS.
