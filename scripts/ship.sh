#!/usr/bin/env bash
# Ship local changes through the repository flow in one command:
#   new branch → commit → push → PR into staging → merge → (optional) PR staging → main → merge.
#
# Usage:
#   scripts/ship.sh <branch> "<commit message>" [--promote]
#
#   <branch>          new work branch, e.g. docs/readme or feat/something
#   <commit message>  conventional commit message in English, also used as the PR title
#   --promote         after merging into staging, also promote staging to main (production)
#
# A PR is merged only if its CI checks pass. If the repository reports no checks at all
# (e.g. GitHub Actions unavailable), the script prints a warning and merges anyway.
set -euo pipefail

usage='usage: scripts/ship.sh <branch> "<commit message>" [--promote]'
branch="${1:?$usage}"
message="${2:?$usage}"
promote="${3:-}"

cd "$(git rev-parse --show-toplevel)"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
staging_links=$'Preview: https://warchest-staging.vercel.app\nDemo: https://warchest-staging.vercel.app/dashboard/?preview=1'


# Always act as the repository owner, whatever account is currently active in `gh`
# (several accounts may be logged in, and another tool may switch the active one).
owner="$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+)/.*#\1#')"
GH_TOKEN="$(gh auth token --hostname github.com --user "$owner")" || {
  echo "gh is not logged in as $owner: run 'gh auth login' with that account" >&2
  exit 1
}
export GH_TOKEN
git_as_owner() {
  git -c credential.helper= \
    -c "credential.helper=!f() { echo username=x-access-token; echo password=\$GH_TOKEN; }; f" "$@"
}

# Waits for the PR's checks. Returns 0 when they pass or when none exist, 1 when they fail.
checks_ok() {
  local url="$1" out
  sleep 20
  out="$(gh pr checks "$url" 2>&1 || true)"
  if grep -q "no checks reported" <<<"$out"; then
    echo "⚠ no CI checks reported for $url — merging without CI" >&2
    return 0
  fi
  if gh pr checks "$url" --watch --interval 15 --fail-fast >/dev/null 2>&1; then
    return 0
  fi
  echo "✗ CI failed: $url" >&2
  gh pr checks "$url" >&2 || true
  return 1
}

if [ -z "$(git status --porcelain)" ]; then
  echo "nothing to ship: the working tree is clean" >&2
  exit 1
fi

git_as_owner fetch -q origin
git checkout -q -b "$branch"
git add -A
git commit -q -m "${message}"
git_as_owner push -q -u origin "$branch"

printf 'Merges `%s` into `staging`.\n\n%s\n' "$branch" "$staging_links" > "$body_file"
url="$(gh pr create --base staging --head "$branch" --title "$message" \
  --body-file "$body_file")"
echo "→ PR into staging: $url"
checks_ok "$url" || exit 1
gh pr merge "$url" --merge --delete-branch
echo "✓ merged into staging"

git checkout -q staging
git_as_owner pull -q origin staging
git branch -D -q "$branch" 2>/dev/null || true

if [ "$promote" = "--promote" ]; then
  printf 'Promotes `staging` to `main` (production).\n\n%s\n' "$staging_links" > "$body_file"
  url="$(gh pr create --base main --head staging --title "release: promote staging to main" \
    --body-file "$body_file")"
  echo "→ PR staging → main: $url"
  checks_ok "$url" || exit 1
  gh pr merge "$url" --merge # staging is never deleted
  echo "✓ promoted staging to main"
  git_as_owner fetch -q origin
  git checkout -q main
  git_as_owner pull -q origin main
  git checkout -q staging
fi
