# turbopanel-sh

Assets-only Workers Static Assets deployment of the daemon installer script on
**turbopanel.sh** — no Worker script, so public installer requests are
free/unbilled. The bare root serves the installer with
`Content-Type: text/x-shellscript; charset=utf-8` and `Cache-Control: no-store`
so `curl | sh` fetches are always fresh.

## Source of truth

`scripts/run.sh` in the daemon repo is the only copy. The deploy flow stages it
into a gitignored `public/bootstrap` before upload — nothing is duplicated in git.

Committed asset config lives under `assets/` (`_headers`, `_redirects`) and is
staged into `public/` by `npm run stage`. Wrangler consumes those files at
deploy time rather than uploading them as downloadable assets.

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
`wrangler.jsonc` first (staging `../../scripts/run.sh` → `public/bootstrap` plus
`assets/_headers` and `assets/_redirects` into `public/`) then uploads.
Cloudflare Workers Builds that invoke `npx wrangler deploy` directly get the
same stage step automatically.

## Verify

```bash
curl -sI https://turbopanel.sh
curl -fsSL turbopanel.sh | head
curl -sI https://turbopanel.sh | grep -E '^(content-type|cache-control):'
```

Expect `200` with the shell body on the bare host, and
`Content-Type: text/x-shellscript; charset=utf-8` plus `Cache-Control: no-store`.
