# Warchest website

Responsive marketing site and protocol notes. Native HTML/CSS/ES modules, no runtime dependencies or external requests. The design study is in `DESIGN.md`.

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

- Seal edition: bone paper, ink and wax red, self-hosted Anton, JetBrains Mono and UnifrakturCook. Design notes in `DESIGN.md`.
- Sections: the chest (10% fee), ranks (interactive calculator), Siege mode, treasury and reserve, build status. Direct entry into the Next.js demo dashboard.
- The rank calculator follows `indexer/src/lots.ts`: rank 0 on the acquisition day, whole UTC days, maximum 10; share weight = tokens × rank.
- Notes (`docs.html`) separate what is built in the repository from what is still in progress.
- Scroll reveals, a seal "press" on load and a moving ribbon, all disabled by reduced-motion settings or the footer motion switch.
