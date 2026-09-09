# SPICE lab sync worker

Private Cloudflare Worker used by the editor when the user opts in to
**lab backup on Save / Export**.

## Behavior

1. Browser downloads `.icproj.json` locally (unchanged).
2. If consent is checked, browser POSTs the project JSON to this worker.
3. Worker reads `CF-Connecting-IP`, hashes it with `IP_HASH_SALT` (never stores raw IP in the issue).
4. KV `LAB_ACTORS` maps `actorShort → issue_number`.
5. Same IP → **update** that issue; new IP → **create** issue labeled `icproj` + `lab-sync`.

Target repo: `SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab` (private).

## Setup

```bash
cd lab-sync-worker
npm install -g wrangler   # or use npx
npx wrangler kv namespace create LAB_ACTORS
npx wrangler kv namespace create LAB_ACTORS --preview
# paste ids into wrangler.toml

npx wrangler secret put GITHUB_TOKEN    # fine-grained PAT: Issues R/W on spice-simulator-lab
npx wrangler secret put IP_HASH_SALT    # long random string
npx wrangler deploy
```

Create labels on the lab repo: `icproj`, `lab-sync`.

## Editor env

In `analog-canvas-js/apps/editor/.env` (or CI):

```bash
VITE_LAB_SYNC_ENDPOINT=https://spice-lab-sync.<your-subdomain>.workers.dev
```

Rebuild / republish the editor after setting this.

## Restore (instructor)

Open issues on `spice-simulator-lab` with label `icproj`. The project JSON is in the issue body fenced block — paste into the editor via Open Project File.
