# turbopanel-sh

Cloudflare Worker that serves the daemon installer script (`run.sh`) from
**https://turbopanel.sh** with correct `Content-Type` and `Cache-Control: no-store`
headers so `curl | sh` fetches are always fresh.

## Source of truth

`scripts/run.sh` in the daemon repo is the only copy. The deploy flow stages it
into a gitignored `public/run.sh` before upload — nothing is duplicated in git.

## Prerequisites

- The **turbopanel.sh** zone must exist in the TurboPanel Cloudflare account so
  the `custom_domain` route can provision DNS and an edge certificate.
- Cloudflare API credentials for `wrangler deploy` (e.g. `CLOUDFLARE_API_TOKEN`).

## Deploy

From this directory:

```bash
npm install
npm run deploy
```

`deploy` runs `stage` (copies `../../scripts/run.sh` → `public/run.sh`) then
`wrangler deploy`. Each deploy re-uploads the asset so content changes take
effect immediately.

## Legacy URL

Existing references to **https://trbp.nl/run.sh** remain valid after repointing
the dashboard-managed redirect to **https://turbopanel.sh** (bare). No code
changes are required in `run.sh` or daemon bootstrap paths — `curl -fsSL`
follows the redirect.

## Verify

```bash
curl -fsSL https://turbopanel.sh | head
curl -fsSL https://turbopanel.sh/run.sh | head
curl -sI https://turbopanel.sh | grep -E '^(content-type|cache-control):'
```

Expect `Content-Type: text/x-shellscript; charset=utf-8` and
`Cache-Control: no-store`.
