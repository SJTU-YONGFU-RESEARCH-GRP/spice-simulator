#!/usr/bin/env bash
set -euo pipefail
cd /mnt/d/proj/spice-simulator
sed -i 's/\r$//' scripts/publish-editor-pages.sh .github/workflows/pages.yml README.md || true
chmod +x scripts/publish-editor-pages.sh

# site/ already filled from Windows Vite build
test -f site/index.html

git add -A
# keep local junk out
git reset -q -- .cursor 2>/dev/null || true
git status -sb

git commit -m "$(cat <<'EOF'
Replace Pages site with schematic editor (Vite :5173 app)

Retire the legacy vanilla MNA UI from gh-pages. Public site now ships
the Analog Canvas JS editor build under /spice-simulator/.
EOF
)"

# Move version tag for this product cut
git tag -d v0.2.0 2>/dev/null || true
git tag -a v0.2.0 -m "SPICE schematic editor v0.2.0"

git push origin master
git push origin v0.2.0

gh release create v0.2.0 --repo SJTU-YONGFU-RESEARCH-GRP/spice-simulator \
  --title "SPICE schematic editor v0.2.0" \
  --notes "Replaces the legacy vanilla simulator UI with the Vite schematic editor (local :5173 app). Site: https://sjtu-yongfu-research-grp.github.io/spice-simulator/" \
  2>/dev/null || gh release edit v0.2.0 --repo SJTU-YONGFU-RESEARCH-GRP/spice-simulator \
  --title "SPICE schematic editor v0.2.0" \
  --notes "Replaces the legacy vanilla simulator UI with the Vite schematic editor (local :5173 app)."

echo "Waiting for Pages deploy…"
sleep 20
gh run list --repo SJTU-YONGFU-RESEARCH-GRP/spice-simulator --limit 3

for i in 1 2 3 4 5 6 7 8; do
  code=$(curl -s -o /tmp/spice-home.html -w "%{http_code}" --max-time 20 \
    "https://sjtu-yongfu-research-grp.github.io/spice-simulator/" || echo 000)
  title=$(grep -o '<title>[^<]*' /tmp/spice-home.html 2>/dev/null | head -1 || true)
  echo "try $i: HTTP $code $title"
  if [[ "$code" == "200" ]] && grep -q 'spice-simulator/assets' /tmp/spice-home.html 2>/dev/null; then
    echo "Editor is live."
    break
  fi
  sleep 15
done
