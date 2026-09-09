#!/usr/bin/env bash
# Publish the Vite editor (http://127.0.0.1:5173 in dev) to GitHub Pages.
#
# Usage (from WSL):
#   cd /mnt/d/proj/spice-simulator
#   ./scripts/publish-editor-pages.sh
#   EDITOR_ROOT=/mnt/d/proj/analog-canvas-js ./scripts/publish-editor-pages.sh
#
# Builds @icm/editor with base=/spice-simulator/, copies into ./site,
# commits, and pushes (CI then updates gh-pages).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EDITOR_ROOT="${EDITOR_ROOT:-$(cd "$ROOT/../analog-canvas-js" 2>/dev/null && pwd || true)}"
if [[ -z "${EDITOR_ROOT}" || ! -d "${EDITOR_ROOT}/apps/editor" ]]; then
  EDITOR_ROOT="/mnt/d/proj/analog-canvas-js"
fi

cd "$ROOT"

echo "Editor root: $EDITOR_ROOT"
echo "Public repo: $ROOT"
echo "Site: https://sjtu-yongfu-research-grp.github.io/spice-simulator/"

if [[ ! -d "$EDITOR_ROOT/node_modules" ]]; then
  echo "Installing editor workspace deps…"
  (cd "$EDITOR_ROOT" && pnpm install)
fi

(cd "$EDITOR_ROOT" && pnpm --filter @icm/editor run build:pages)

DIST="$EDITOR_ROOT/apps/editor/dist"
if [[ ! -f "$DIST/index.html" ]]; then
  echo "Build missing: $DIST/index.html" >&2
  exit 1
fi

rm -rf "$ROOT/site"
mkdir -p "$ROOT/site"
cp -a "$DIST"/. "$ROOT/site"/
cp -f "$ROOT/site/index.html" "$ROOT/site/404.html"

# Keep AGPL notice next to the shipped UI when present.
if [[ -f "$EDITOR_ROOT/LICENSE.md" ]]; then
  cp -f "$EDITOR_ROOT/LICENSE.md" "$ROOT/site/LICENSE.md"
fi
if [[ -f "$EDITOR_ROOT/NOTICE.md" ]]; then
  cp -f "$EDITOR_ROOT/NOTICE.md" "$ROOT/site/NOTICE.md"
fi

printf '%s\n' "{
  \"app\": \"spice-schematic-editor\",
  \"source\": \"analog-canvas-js\",
  \"base\": \"/spice-simulator/\",
  \"builtAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
}" > "$ROOT/site/release-manifest.json"

git add site .github/workflows/pages.yml
if git diff --cached --quiet; then
  echo "No site changes to commit."
else
  git commit -m "Publish schematic editor to Pages (replace legacy simulator UI)"
fi

# Prefer SSH from WSL
remote_url="$(git remote get-url origin)"
if [[ "$remote_url" == https://github.com/* ]]; then
  git remote set-url origin "git@github.com:${remote_url#https://github.com/}"
  git remote set-url origin "$(git remote get-url origin | sed 's#/$##;s#\.git$#.git#')"
fi

git push origin HEAD

echo
echo "Pushed. Pages will update from ./site → gh-pages."
echo "Open: https://sjtu-yongfu-research-grp.github.io/spice-simulator/"
