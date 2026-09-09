#!/usr/bin/env bash
set -euo pipefail
cd /mnt/d/proj/spice-simulator
sed -i 's/\r$//' scripts/release.sh scripts/publish-editor-pages.sh README.md docs/*.md .gitignore package.json || true
chmod +x scripts/release.sh scripts/publish-editor-pages.sh

# Remove legacy vanilla simulator from git
git rm -rf --ignore-unmatch \
  src styles lib vendor index.html .nojekyll \
  scripts/build-release.mjs scripts/serve.mjs scripts/smoke.mjs scripts/probe-ngspice.mjs \
  package-lock.json models \
  2>/dev/null || true

# Local untracked leftovers
rm -rf release node_modules src styles lib vendor models 2>/dev/null || true
rm -f index.html .nojekyll package-lock.json 2>/dev/null || true

git add -A
git reset -q -- .cursor _tmp_quiz_challenge_platform 2>/dev/null || true
git status -sb

git commit -m "$(cat <<'EOF'
Remove legacy vanilla MNA simulator from public repo

Keep only the Vite editor Pages bundle (site/) and publish/release scripts.
EOF
)"

git push origin master
echo "Done. Legacy tree removed from master."
git ls-tree --name-only HEAD
