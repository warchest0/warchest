# Frontend delivery: GitHub Actions → Vercel

Two frontends, one static deployment:

- `/`: custom marketing website from `web/`.
- `/docs.html`: protocol documentation.
- `/dashboard/?preview=1`, `/vote/`, `/treasury/`, `/leaderboard/`: Next.js dApp from `app/`.

The dApp build explicitly sets `NEXT_PUBLIC_DEMO=1`. Its figures and actions are simulations, labelled in the UI; publishing the frontend does not deploy contracts or operate a keeper.

## Branches and projects

| Git branch | GitHub environment | Vercel project |
| --- | --- | --- |
| `staging` | `staging` | `warchest-staging` |
| `main` | `production` | `warchest` |

PRs run validation without deploying. Pushes or manual workflow runs on either branch deploy only after the contracts, indexer, keeper, frontend and Docker jobs succeed. Deployment concurrency is serialized per branch. Production is updated by the existing PR promotion flow from `staging` to `main`.

`.github/workflows/test.yml` builds the dApp and marketing site, assembles `.vercel/output/` with `scripts/build-frontend.mjs`, checks its routes/assets, and uploads that exact artifact. The deployment job downloads it and uses Vercel CLI `59.26.0` with `--prebuilt --prod`; it does not rebuild source or operate backend services. A failed deployment or route smoke check makes the workflow fail. The resulting URL appears in the Actions summary and GitHub environment.

Vercel native Git deployments are disabled in `vercel.json`, avoiding duplicate deployments and bypasses of CI. Both projects serve public previews; Vercel SSO protection is disabled for these frontend-only projects.

## Repository configuration

Repository variables (configured):

- `VERCEL_ORG_ID`: Vercel team identifier.
- `VERCEL_STAGING_PROJECT_ID`: staging project identifier.
- `VERCEL_PRODUCTION_PROJECT_ID`: production project identifier.

Required encrypted repository secret:

- `VERCEL_TOKEN`: a Vercel access token with deployment access to both Warchest projects. Create through https://vercel.com/account/tokens and store at https://github.com/warchest0/warchest/settings/secrets/actions . Never commit a token or paste it into an issue. Rotate before its chosen expiry.

The local CLI OAuth session can deploy interactively but cannot create a long-lived CI token. A `VERCEL_OIDC_TOKEN` downloaded by `vercel link` is not a replacement for `VERCEL_TOKEN`.

## Local reproduction

Requires Node 24.

```sh
npm ci --prefix app
npm --prefix web run check
npm --prefix app run typecheck
npm --prefix app run lint
npm --prefix app test
NEXT_PUBLIC_DEMO=1 npm --prefix app run build
npm --prefix web run build
node scripts/build-frontend.mjs
node scripts/check-frontend.mjs
```

The artifact has no functions or private keys. Only public frontend output is uploaded. Root `.env*`, `.vercel/`, dependencies and generated outputs are ignored by Git.

## Manual deployment and recovery

For a manual release, first reproduce the build above and ensure CI for the commit is green. Link to the intended project with `vercel link --project warchest-staging --yes` (or `warchest` for production), then use `vercel deploy --prebuilt --prod --yes`. `vercel link` may create an ignored `.env.local`; it must remain local.

If a regression is published, use Vercel's project deployment history to restore the previous ready deployment, then fix the source through a PR. Do not enable live contract addresses merely to remove the demo badge: backend deployment and validation are separate work.
