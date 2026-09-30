# Repository conventions

- Never add AI tools or models as authors, co-authors, contributors, or commit/PR/release signatures. In particular, do not add AI attribution or generated-by footers. Preserve human authorship.
- Include the staging preview in release notes and promotion PRs: https://warchest-staging.vercel.app
- The production release is https://warchest-app.vercel.app (alias set by the deploy job on `main`)
- The demo app is https://warchest-staging.vercel.app/dashboard/?preview=1
- Never claim deployment succeeded when its credentials are missing or its checks failed.
