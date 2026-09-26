# turbopanel-sh

Assets-only Workers Static Assets deployment on **turbopanel.sh** — no Worker
script, so installer requests are free/unbilled. It hosts nothing: every path
is a `301` to the installer's one source of truth on GitHub,

    https://raw.githubusercontent.com/TurboPanel/turbopaneld/live/scripts/run.sh

`curl -fsSL turbopanel.sh | sh` follows it (`-L`). `live` moves only when a
release is promoted, so installer changes ship at release cadence.

## What is committed

`assets/_redirects` (the rules) and `assets/_headers` (`Cache-Control:
no-store`). `pnpm run stage` copies both into gitignored `public/`; wrangler
consumes them as config rather than uploading them as assets.

## Prerequisites

- The **turbopanel.sh** zone must exist in the TurboPanel Cloudflare account so
  the `custom_domain` route can provision DNS and an edge certificate.
- Cloudflare API credentials for `wrangler deploy` (e.g. `CLOUDFLARE_API_TOKEN`).

## Deploy

From this directory:

```bash
pnpm install --frozen-lockfile
pnpm deploy
```

`pnpm-lock.yaml` is committed so Cloudflare Workers Builds installs with pnpm
deterministically. The lockfile must include pnpm 12's `packageManagerDependencies`
catalog — `--frozen-lockfile` fails without it. `pnpm-workspace.yaml` must
`allowBuilds` for `esbuild` and `workerd` (wrangler postinstalls); pnpm 12
`strictDepBuilds` otherwise fails the install with `ERR_PNPM_IGNORED_BUILDS`.

`deploy` runs `wrangler deploy`, which executes the `build.command` in
`wrangler.jsonc` first (`pnpm run stage`) then uploads. Cloudflare Workers
Builds that invoke `npx wrangler deploy` directly get the same stage step.

## Verify

```bash
curl -sI https://turbopanel.sh | grep -Ei '^(HTTP|location):'
curl -fsSL turbopanel.sh | head -3
```

Expect `HTTP/2 301` with `location: https://raw.githubusercontent.com/TurboPanel/turbopaneld/live/scripts/run.sh` and, once followed, the shell script.
