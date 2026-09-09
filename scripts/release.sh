#!/usr/bin/env bash
# Create a versioned release: bump semver, build obfuscated release/, commit, tag, push.
#
# Usage:
#   ./scripts/release.sh              # patch bump (0.1.0 -> 0.1.1)
#   ./scripts/release.sh minor        # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major        # 0.1.0 -> 1.0.0
#   ./scripts/release.sh 0.1.0        # set exact version (first release)
#   ./scripts/release.sh patch --dry-run
#   ./scripts/release.sh 0.1.0 --no-push
#
# Env:
#   RELEASE_REMOTE   default: origin
#   RELEASE_BRANCH   default: current branch (or master/main)
#   SKIP_BUILD=1     skip npm run build:release

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Author identity for commits/tags (does not write to git config).
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
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f package.json ]]; then
  echo "package.json not found in $ROOT" >&2
  exit 1
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
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo master)"
if [[ "$branch" == "HEAD" ]]; then
  branch="${RELEASE_BRANCH:-master}"
fi

PUBLIC_URL="https://sjtu-yongfu-research-grp.github.io/spice-simulator/"

echo "SPICE Simulator release"
echo "  current : $current"
echo "  next    : $next ($tag)"
echo "  branch  : $branch"
echo "  remote  : $REMOTE"
echo "  site    : $PUBLIC_URL"
echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry run — no build, commit, tag, or push."
  exit 0
fi

if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
  # Allow dirty tree only if we are about to commit everything for release.
  echo "Working tree has local changes; they will be included in the release commit."
fi

# Keep homepage / version in package.json in sync.
node --input-type=commonjs <<EOF
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = "$next";
pkg.homepage = "$PUBLIC_URL";
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
EOF

printf '%s\n' "$next" > VERSION

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  if [[ ! -d node_modules/terser ]]; then
    npm install
  fi
  npm run build:release
else
  echo "SKIP_BUILD=1 — not rebuilding release/"
fi

# Verify release bundle exists
if [[ ! -f release/index.html ]] || [[ ! -f release/release-manifest.json ]]; then
  echo "release/ bundle missing — build failed?" >&2
  exit 1
fi

# Stamp version into the Pages bundle
node --input-type=commonjs <<EOF
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync("release/release-manifest.json", "utf8"));
manifest.version = "$next";
manifest.homepage = "$PUBLIC_URL";
fs.writeFileSync(
  "release/release-manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
EOF

git add -A
# Do not accidentally stage secrets or local junk if somehow un-ignored
git reset -q -- .cursor 2>/dev/null || true

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  if git diff --cached --quiet; then
    echo "Nothing to commit (already at $next?)."
  else
    git commit -m "$(cat <<EOF
Release ${tag}

Public site: ${PUBLIC_URL}
EOF
)"
  fi
else
  # First commit on an empty repo
  git commit -m "$(cat <<EOF
Release ${tag}

Initial public release of SPICE Simulator.
Public site: ${PUBLIC_URL}
EOF
)"
fi

if git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Tag $tag already exists locally."
else
  git tag -a "$tag" -m "SPICE Simulator ${tag}"
fi

if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "Skipping push (--no-push). Local tag: $tag"
  exit 0
fi

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "Remote '$REMOTE' is not configured." >&2
  echo "Add it first, e.g.:" >&2
  echo "  git remote add origin https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator.git" >&2
  exit 1
fi

git push -u "$REMOTE" "$branch"
git push "$REMOTE" "$tag"

if command -v gh >/dev/null 2>&1; then
  if gh release view "$tag" >/dev/null 2>&1; then
    echo "GitHub release $tag already exists."
  else
    gh release create "$tag" \
      --title "SPICE Simulator ${tag}" \
      --notes "$(cat <<EOF
## SPICE Simulator ${tag}

- Site: ${PUBLIC_URL}
- Obfuscated Pages bundle built via \`npm run build:release\`
- Issues / lab shares belong on the private repo \`spice-simulator-lab\`

EOF
)"
  fi
else
  echo "gh CLI not found — tag pushed; create the GitHub Release in the UI if desired."
fi

echo
echo "Done. ${tag} → ${PUBLIC_URL}"
