# turbopanel-sh

Assets-only Workers Static Assets deployment of the daemon installer script
(`run.sh`) on **https://turbopanel.sh** — no Worker script, so public installer
requests are free/unbilled. `/run.sh` is the static asset; the bare root is a
`200` proxy rewrite to that file (no client redirect). Both paths are served
with `Content-Type: text/x-shellscript; charset=utf-8` and
`Cache-Control: no-store` so `curl | sh` fetches are always fresh.

## Source of truth

`scripts/run.sh` in the daemon repo is the only copy. The deploy flow stages it
into a gitignored `public/run.sh` before upload — nothing is duplicated in git.

Committed asset config lives under `assets/` (`_headers`, `_redirects`) and is
staged into `public/` next to `run.sh` by `npm run stage`. Wrangler consumes
those files at deploy time rather than uploading them as downloadable assets.

Non-GET/HEAD requests no longer get a hand-rolled `405` from Worker code —
method handling is whatever the asset server returns.

## Prerequisites

- The **turbopanel.sh** zone must exist in the TurboPanel Cloudflare account so
  the `custom_domain` route can provision DNS and an edge certificate.
- Cloudflare API credentials for `wrangler deploy` (e.g. `CLOUDFLARE_API_TOKEN`).

## Deploy

From this directory:

```bash
npm ci
npm run deploy
```

`package-lock.json` is committed so Cloudflare Workers Builds installs with npm
deterministically. Local installs may use `npm install` instead of `npm ci` when
the lockfile changes.

`deploy` runs `wrangler deploy`, which executes the `build.command` in
`wrangler.jsonc` first (staging `../../scripts/run.sh` → `public/run.sh` plus
`assets/_headers` and `assets/_redirects` into `public/`) then uploads.
Cloudflare Workers Builds that invoke `npx wrangler deploy` directly get the
same stage step automatically.

## Legacy URL

Existing references to **https://trbp.nl/run.sh** remain valid after repointing
the dashboard-managed redirect to be **path-preserving**
(`trbp.nl/run.sh` → `https://turbopanel.sh/run.sh`) so installs resolve in one
hop instead of bouncing through the bare host. No code changes are required in
`run.sh` or daemon bootstrap paths — `curl -fsSL` follows the redirect.

## Verify

```bash
curl -sI https://turbopanel.sh
curl -fsSL https://turbopanel.sh | head
curl -fsSL https://turbopanel.sh/run.sh | head
curl -sI https://turbopanel.sh/run.sh | grep -E '^(content-type|cache-control):'
```

Expect `200` with the shell body on both the bare host and `/run.sh`, and
`Content-Type: text/x-shellscript; charset=utf-8` plus `Cache-Control: no-store`
on each. No `-L` is required for the bare host.
