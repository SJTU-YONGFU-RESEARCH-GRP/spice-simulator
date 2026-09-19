#!/usr/bin/env bash
# Version bump + tag + push for the public Pages repo.
#
# Prefer WSL:
#   cd /mnt/d/proj/spice-simulator && ./scripts/release.sh
#   ./scripts/release.sh minor
#   ./scripts/release.sh 0.3.0 --no-push
#
# By default refreshes ./site from the editor source tree (SKIP_BUILD=1 to skip).
#
# --no-push suppresses every push this script makes, including the one inside
# the publish step it invokes, so a release is never pushed from two places.
#
# site/ must pass scripts/check-artifacts.mjs before it is committed, unless
# SKIP_ARTIFACT_GUARD=1. A rebuild also refuses to delete a site/ that has
# uncommitted changes unless ALLOW_DIRTY_SITE=1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REMOTE="${RELEASE_REMOTE:-origin}"
DRY_RUN=0
NO_PUSH=0
BUMP="patch"

# Parse arguments before ensure_pnpm, so --help and --dry-run work without a
# package manager. Otherwise corepack silently downloads one just to print help.
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-push) NO_PUSH=1 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    -h|--help)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

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

if [[ -z "$(git config user.name 2>/dev/null || true)" ]]; then
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-SJTU-YONGFU-RESEARCH-GRP}"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
fi
if [[ -z "$(git config user.email 2>/dev/null || true)" ]]; then
  export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-noreply@users.noreply.github.com}"
  export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"
fi

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
  bash scripts/publish-editor-pages.sh --no-push || {
    # The publish script owns the rebuild. This is the stand-in for when it
    # cannot run at all, and it applies the same two safety gates.
    EDITOR_ROOT="${EDITOR_ROOT:-}"
    if [[ -z "$EDITOR_ROOT" || ! -d "$EDITOR_ROOT/apps/editor" ]]; then
      for c in \
        "$ROOT/../spice-simulator-editor" \
        "$ROOT/../analog-canvas-js" \
        "/mnt/d/proj/spice-simulator-editor" \
        "/mnt/d/proj/analog-canvas-js"
      do
        if [[ -d "$c/apps/editor" ]]; then
          EDITOR_ROOT="$(cd "$c" && pwd)"
          break
        fi
      done
    fi
    if [[ -d "$EDITOR_ROOT/apps/editor" ]]; then
      (cd "$EDITOR_ROOT" && pnpm --filter @icm/editor run build:pages)
      # Same refusal as the publish script: uncommitted work in site/ has no
      # other copy, and the next line deletes the directory outright.
      dirty_site="$(git -C "$ROOT" status --porcelain -- site || true)"
      if [[ -n "$dirty_site" && "${ALLOW_DIRTY_SITE:-0}" != "1" ]]; then
        {
          echo "Refusing to rebuild: site/ has uncommitted changes that 'rm -rf site' would destroy."
          printf '%s\n' "$dirty_site"
          echo "Commit or stash them first; ALLOW_DIRTY_SITE=1 discards them on purpose."
        } >&2
        exit 1
      fi
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

# Last gate before anything reaches git. Whatever is in site/ right now is what
# ships, and this is the only gate the SKIP_BUILD=1 and fallback-rebuild paths
# pass through -- SKIP_BUILD=1 is how a hand-edited site/ would be released.
if [[ "${SKIP_ARTIFACT_GUARD:-0}" == "1" ]]; then
  echo "WARN: SKIP_ARTIFACT_GUARD=1 — releasing site/ without the artifact guard." >&2
else
  node scripts/check-artifacts.mjs --accept=scripts/known-deviations.json || {
    echo "Artifact guard failed — refusing to commit or push site/." >&2
    exit 1
  }
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
- Vite editor bundle in \`site/\` (SPICE schematic editor)
- Issues belong on private \`spice-simulator-lab\`
EOF
)"
  fi
fi

echo "Done. ${tag} → ${PUBLIC_URL}"
