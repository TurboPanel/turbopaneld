# Installer script hosting (`workers/turbopanel-sh/`) — AGENTS.md

Daemon repo context: `../../AGENTS.md`.

**https://turbopanel.sh is a redirect, not a host.** The Worker is still
**assets-only** — no Worker script, so installer traffic never bills — but it
uploads no copy of the installer any more. `assets/_redirects` answers every
path (`/`, `/run.sh`, the retired `/bootstrap`, and a `/*` catch-all) with a
**301** to the one source of truth on GitHub:

    https://raw.githubusercontent.com/TurboPanel/turbopaneld/live/scripts/run.sh

`live` is the branch a release promotion fast-forwards, so an installer change
reaches new installs at release cadence, matching the `release` channel the
script installs by default. `curl -fsSL turbopanel.sh | sh` keeps working
because `-L` follows the redirect, and every automatic-update consumer already
fetches with `-L`: `tp-orchestrate update` (`CDN_RUN_SCRIPT`), the daemon's
`downloadRunScript` (`src/instance/run-reconcile.ts`), and run.sh's own
re-exec. `scripts/turbopanel-sh-redirect.test.ts` pins the rules, the `-L`
contract, and a live curl-follows-301 round trip. Threat model is unchanged: a
party who could tamper with the zone could serve a bad script directly, so the
redirect widens nothing; the release rail's signed manifests protect what the
script then installs. `assets/_headers` keeps `Cache-Control: no-store` on
`/*`; a cached 301 is harmless because the target URL is stable.

Deploy tooling lives in the isolated `workers/turbopanel-sh/` package (Node +
wrangler only — not part of the Deno graph). Cloudflare Workers Builds runs
`pnpm install --frozen-lockfile`; `pnpm-workspace.yaml` must `allowBuilds`
`esbuild` and `workerd` or pnpm 12 fails with `ERR_PNPM_IGNORED_BUILDS`.
Manual deploy: `pnpm install` then `pnpm deploy` from that directory; the stage
step copies only `assets/_headers` and `assets/_redirects` into gitignored
`public/` (`pnpm run stage`). The `workers/` tree is deploy tooling only and is
excluded from release packaging (`package-daemon-release.sh` /
`bundle-orchestration.sh` stage from `orchestration/` and `dist/.build` only).

**Overlay catalog (`TURBOPANEL_DL_BASE`):** co-located development Caddy serves
`/run.sh` and `/downloads/daemon/*` from the daemon checkout. Remote servers
installed through that overlay receive `TURBOPANEL_DL_BASE=<origin>/downloads/daemon`
(persisted in `daemon.env`) and must **never** fall back to `https://dl.trbp.nl`.
A configured `TURBOPANEL_DL_BASE` that is not https is refused
(`InsecureOverlayBaseError`); only an absent base selects the public rail.
Catalog URLs in `dist/channels.json` / `dist/manifest.json` are relative so the
same files work behind LAN HTTPS on `:8443` and a Cloudflare tunnel.
`run.sh --insecure-tls` still only relaxes the platform-CA instance legs;
public :443 TLS (tunnel) uses the system store. Rebuild the overlay with
`deno task release:dev` (dev console **Rebuild daemon and upgrade connected servers**).
Each `release:dev` stamps overlay `commit` as `<40-char-sha>+<unix-seconds>`
(baked into the binaries **and** the catalog). `sourceUrl` keeps the full
immutable source commit (the SHA before `+`). Remotes skip reconcile when
`getBuildInfo().commit` already matches the catalog; a plain git SHA would
make **U** a no-op until HEAD moves. Production `release` stores the full
40-character git SHA in `BUILD_INFO.commit`, `BUILD_INFO.sourceUrl`, and
`ChannelManifest.commit` (short SHA is only for `buildId` / logs).

