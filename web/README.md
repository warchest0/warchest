# Warchest website

Original responsive marketing site and protocol preview. Native HTML/CSS/ES modules, local WebGL scenes, no runtime dependencies or external requests. The design study is in `DESIGN.md`.

## Run

Requires Node 22 or newer. From the repository root:

```sh
cd web
npm run dev
```

Open http://localhost:4173. Set `PORT` to override. The development server binds to loopback and only serves public asset types.

## Validate and build

```sh
npm run check
npm run build
```

Deploy the resulting `web/dist/` directory to any static host. Both `index.html` and `docs.html` are standalone routes. No application secrets or backend service is needed.

## Functional scope

- Photographic WebGL Earth horizon and blue point-map globe with moving routes, visibility-aware rendering, eased zoom/rotation, pause controls and reduced-motion support. A Canvas renderer remains available when WebGL is unavailable.
- Direct entry into the Next.js demo dashboard, mobile navigation, in-page links, treasury stage selector.
- Holding-days calculator follows `indexer/src/lots.ts`: level 0 on the acquisition day, whole UTC days, maximum 10; integer voting weights.
- Documentation tracks the repository's implemented architecture and pending deployment/audit work.

The Vercel pipeline combines this website with the demo dApp in `app/` (see `deploy/FRONTEND.md`). This is a pre-launch frontend: no invented on-chain data, wallet transactions, token address or enabled profit distribution. A real application will need deployed contract addresses, RPC configuration, the indexer API and wallet integration. Geographical arcs are conceptual and explicitly labelled.

Assets and provenance: `assets/README.md`. Inter is self-hosted with system font fallbacks. All motion can be turned off in the footer; the OS reduced-motion preference is honored.
