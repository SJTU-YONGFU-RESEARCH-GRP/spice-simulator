#!/usr/bin/env bash
# Publish the Vite editor (http://127.0.0.1:5173 in dev) to GitHub Pages.
#
# Usage (from WSL):
#   cd /mnt/d/proj/spice-simulator
#   ./scripts/publish-editor-pages.sh
#   EDITOR_ROOT=/path/to/editor-source ./scripts/publish-editor-pages.sh
#
# Builds @icm/editor with base=/spice-simulator/, copies into ./site,
# commits, and pushes (CI then updates gh-pages).
# Default EDITOR_ROOT resolves spice-simulator-editor, then analog-canvas-js.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# WSL often starts with apt Node 12 on PATH; prefer nvm Node 24 + corepack pnpm.
ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm not found. In WSL: source ~/.nvm/nvm.sh && nvm use 24 && corepack enable" >&2
    exit 1
  fi
  echo "Using pnpm $(pnpm -v) · node $(node -v)"
}

ensure_pnpm

resolve_editor_root() {
  local candidates=(
    "${EDITOR_ROOT:-}"
    "$ROOT/../spice-simulator-editor"
    "$ROOT/../analog-canvas-js"
    "/mnt/d/proj/spice-simulator-editor"
    "/mnt/d/proj/analog-canvas-js"
  )
  local c
  for c in "${candidates[@]}"; do
    [[ -n "$c" && -d "$c/apps/editor" ]] && { printf '%s\n' "$(cd "$c" && pwd)"; return 0; }
  done
  return 1
}

EDITOR_ROOT="$(resolve_editor_root || true)"
if [[ -z "${EDITOR_ROOT}" ]]; then
  echo "Editor source not found. Set EDITOR_ROOT to spice-simulator-editor (or analog-canvas-js)." >&2
  exit 1
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
  \"source\": \"spice-simulator\",
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
