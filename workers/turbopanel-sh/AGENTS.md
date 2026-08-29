# Installer script hosting (`workers/turbopanel-sh/`) — AGENTS.md

Daemon repo context: `../../AGENTS.md`.

**https://turbopanel.sh** is the canonical **assets-only** Workers Static Assets
host for the daemon installer script — **no Worker script**, so public installer traffic
can never generate Worker invocation billing. `_headers` sets the shellscript
content type + `no-store` on `/`.
Deploy tooling lives in the isolated `workers/turbopanel-sh/` package (Node +
wrangler only — not part of the Deno graph). Manual deploy: `npm install` then
`npm run deploy` from that directory; the stage step copies `scripts/run.sh` to
`public/bootstrap` (plus committed `assets/_headers` and `assets/_redirects`) into
gitignored `public/` at deploy time so the script stays a single source of truth. The
`workers/` tree is deploy tooling only and is
excluded from release packaging (`package-daemon-release.sh` /
`bundle-orchestration.sh` stage from `orchestration/` and `dist/.build` only).

**Overlay catalog (`TURBOPANEL_DL_BASE`):** co-located development Caddy serves
`/run.sh` and `/downloads/daemon/*` from the daemon checkout. Remote servers
installed through that overlay receive `TURBOPANEL_DL_BASE=<origin>/downloads/daemon`
(persisted in `daemon.env`) and must **never** fall back to `https://dl.trbp.nl`.
Catalog URLs in `dist/channels.json` / `dist/manifest.json` are relative so the
same files work behind LAN HTTPS, plaintext `:8880`, and a Cloudflare tunnel.
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

