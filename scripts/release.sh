#!/usr/bin/env bash
# Version bump + tag + push for the public Pages repo.
#
# Prefer WSL:
#   cd /mnt/d/proj/spice-simulator && ./scripts/release.sh
#   ./scripts/release.sh minor
#   ./scripts/release.sh 0.3.0 --no-push
#
# By default refreshes ./site from analog-canvas-js (SKIP_BUILD=1 to skip).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "$(git config user.name 2>/dev/null || true)" ]]; then
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-SJTU-YONGFU-RESEARCH-GRP}"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
fi
if [[ -z "$(git config user.email 2>/dev/null || true)" ]]; then
  export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-noreply@users.noreply.github.com}"
  export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"
fi

REMOTE="${RELEASE_REMOTE:-origin}"
DRY_RUN=0
NO_PUSH=0
BUMP="patch"

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-push) NO_PUSH=1 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

current="$(node --input-type=commonjs -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")"
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  next="$BUMP"
else
  next="$(node --input-type=commonjs -e "
    const [ma, mi, pa] = process.argv[1].split('.').map(Number);
    const bump = process.argv[2];
    let out;
    if (bump === 'major') out = [ma + 1, 0, 0];
    else if (bump === 'minor') out = [ma, mi + 1, 0];
    else out = [ma, mi, pa + 1];
    console.log(out.join('.'));
  " "$current" "$BUMP")"
fi

tag="v${next}"
branch="$(git symbolic-ref --short HEAD 2>/dev/null || true)"
if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
  branch="${RELEASE_BRANCH:-master}"
fi

PUBLIC_URL="https://sjtu-yongfu-research-grp.github.io/spice-simulator/"

echo "SPICE schematic editor release"
echo "  current : $current"
echo "  next    : $next ($tag)"
echo "  branch  : $branch"
echo "  site    : $PUBLIC_URL"
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run — no build, commit, tag, or push."
  exit 0
fi

node --input-type=commonjs <<EOF
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = "$next";
pkg.homepage = "$PUBLIC_URL";
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
EOF

printf '%s\n' "$next" > VERSION

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  bash scripts/publish-editor-pages.sh --no-push 2>/dev/null || {
    # publish script always pushes; rebuild site inline instead
    EDITOR_ROOT="${EDITOR_ROOT:-/mnt/d/proj/analog-canvas-js}"
    if [[ -d "$EDITOR_ROOT/apps/editor" ]]; then
      (cd "$EDITOR_ROOT" && pnpm --filter @icm/editor run build:pages)
      rm -rf site
      mkdir -p site
      cp -a "$EDITOR_ROOT/apps/editor/dist"/. site/
      cp -f site/index.html site/404.html
      [[ -f "$EDITOR_ROOT/LICENSE.md" ]] && cp -f "$EDITOR_ROOT/LICENSE.md" site/
      [[ -f "$EDITOR_ROOT/NOTICE.md" ]] && cp -f "$EDITOR_ROOT/NOTICE.md" site/
    else
      echo "WARN: editor root missing; keeping existing ./site"
    fi
  }
fi

if [[ ! -f site/index.html ]]; then
  echo "site/index.html missing — publish the editor first." >&2
  exit 1
fi

if [[ -f site/release-manifest.json ]]; then
  node --input-type=commonjs <<EOF
const fs = require("fs");
const m = JSON.parse(fs.readFileSync("site/release-manifest.json", "utf8"));
m.version = "$next";
m.homepage = "$PUBLIC_URL";
fs.writeFileSync("site/release-manifest.json", JSON.stringify(m, null, 2) + "\n");
EOF
fi

git add -A
git reset -q -- .cursor 2>/dev/null || true

if git diff --cached --quiet; then
  echo "Nothing to commit (already at $next?)."
else
  git commit -m "$(cat <<EOF
Release ${tag}

Public site: ${PUBLIC_URL}
EOF
)"
fi

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Tag $tag already exists locally."
else
  git tag -a "$tag" -m "SPICE schematic editor ${tag}"
fi

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "Skipping push (--no-push). Local tag: $tag"
  exit 0
fi

remote_url="$(git remote get-url "$REMOTE")"
if [[ "$remote_url" == https://github.com/* ]]; then
  ssh_url="git@github.com:${remote_url#https://github.com/}"
  ssh_url="${ssh_url%.git}.git"
  if [[ -f "${HOME}/.ssh/id_ed25519" || -f "${HOME}/.ssh/id_rsa" ]]; then
    git remote set-url "$REMOTE" "$ssh_url"
  fi
fi

git push -u "$REMOTE" "$branch"
git push "$REMOTE" "$tag"

if command -v gh >/dev/null 2>&1; then
  if ! gh release view "$tag" >/dev/null 2>&1; then
    gh release create "$tag" \
      --title "SPICE schematic editor ${tag}" \
      --notes "$(cat <<EOF
## SPICE schematic editor ${tag}

- Site: ${PUBLIC_URL}
- Vite editor bundle in \`site/\` (from analog-canvas-js)
- Issues belong on private \`spice-simulator-lab\`
EOF
)"
  fi
fi

echo "Done. ${tag} → ${PUBLIC_URL}"
