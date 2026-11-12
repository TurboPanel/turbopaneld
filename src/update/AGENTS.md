# Updates and Signed Manifests — AGENTS.md

Daemon repo context: `../../AGENTS.md`. Cross-repo `../<repo>/…` links are relative to the repo root.

## Signed Manifests and Update Trust

- **Signed manifests** — `src/update/signing.ts`: every production channel
  manifest carries an Ed25519 `signature` over its canonical JSON (sorted
  keys, compact, `signature` removed). `generate-channel-manifest.ts` signs
  with `RELEASE_SIGNING_KEY` (PKCS#8 PEM; in CI the env var is mapped from the `TURBOPANEL_RELEASE_SIGNING_KEY` environment secret: `canary` environment for `publish-daemon-trunk.yml`, `rc`/`release` for the promote path and `release.yml`) and **refuses to
  write an unsigned manifest**. The public key is pinned twice —
  `RELEASE_SIGNING_PUBLIC_KEY_HEX` and `TP_RELEASE_SIGNING_PUBLIC_KEY` in
  `run.sh` (`signing.test.ts` pins them together, and byte-compares Deno's
  canonicaliser with run.sh's python3 one). `resolveUpdate` verifies **before
  parsing** for any production install; run.sh verifies before any artifact
  download (`tp_verify_manifest_signature`, openssl `pkeyutl -rawin`). The
  only bypass is development-side and host-side: a source checkout
  (development install mode), or a `--dl-base` overlay host whose
  `daemon.env` carries `TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST=1`
  (`daemon-config/dotenv.j2` writes it for overlay installs only). run.sh needs
  the same second opt-in: `TURBOPANEL_DL_BASE` alone (ambient env, a pasted
  one-liner) does **not** skip verification; the install must also pass
  `--dev-allow-unsigned` (or `TURBOPANEL_DEV_ALLOW_UNSIGNED_MANIFEST=1`, which
  does not survive the sudo re-exec, so the flag is forwarded) and
  `tp-orchestrate update` adds it for a root-pinned overlay. The
  built-in rail and `TURBOPANEL_MANIFEST_URL` pins always verify. Instance/UI
  repo manifests (`--instance` installs) are signed by their release jobs with
  the same key: TurboPanel/turbopanel and TurboPanel/ui run
  `scripts/sign-manifest.ts` from a SHA-pinned checkout of this repo, so one
  signer and one canonicaliser cover every package. It refuses to publish an
  unsigned manifest and fails when `RELEASE_SIGNING_KEY` does not match the
  key pinned in `signing.ts`. Verification follows the same single rule as the
  daemon package: an unsigned or invalidly signed instance/UI manifest is a
  refusal — in `run.sh` (`tp_fetch_repo_manifest`, before any field is read)
  and in the control-plane update preflight (`preflight_manifest`,
  `assertControlPlaneManifestPreflight`) — with the same development-only
  bypass (source checkout, or an opted-in `--dl-base` overlay). Enforced since
  2026-09-26: releases published before signing existed (v0.1.0 on
  `release`/`rc`) no longer install; publish and promote a signed release.
  Tests: `src/instance/run-sh-manifest-signature.test.ts`,
  `src/instance/run-reconcile.test.ts`.
- **Release-rail manifest URLs** — every manifest pin (run.sh
  `--manifest-url` / `--instance-manifest-url` / `--ui-manifest-url` and
  their env vars, tp-orchestrate `update` / `update-instance`, the
  `manifestUrl` / `uiManifestUrl` on a cell message, and the env pins
  `resolvePinnedManifestUrl` reads) must name that package's own rail:
  `https://github.com/TurboPanel/<repo>/releases/{download/<tag>,latest/download}/manifest*.json`.
  The check runs on the raw string — exact host, no `%`/`@`/`:`/`?`/`#`/`\`/
  whitespace, no empty/`.`/`..` segment — so nothing a client would
  normalise onto another path can pass, and run.sh fetches pins with
  `curl --path-as-is`. The rule exists three times: `tp_release_manifest_url_ok`
  (byte-identical in run.sh and tp-orchestrate) and `releaseManifestUrlAllowed`
  (`src/update/urls.ts`). `src/update/release-manifest-url-policy.test.ts`
  runs all three over `src/testing/release-manifest-url-corpus.json`
  (hostile and legitimate shapes); add a case there when a rail changes.
- **Automatic-update TLS** — `resolveAutomaticUpdateTrust`
  (`src/instance/run-reconcile.ts`): public trust or the
  configured Platform CA file; otherwise `UpdateTrustRepairError` naming
  `--instance-ca`. `TURBOPANEL_RELEASE_TLS_INSECURE` and `--insecure-tls` are
  never consulted on that path (manual `run.sh` keeps the flag).

## Manifest freshness (no rollback by replay)

A signature proves who made a manifest, not that it is current.
`resolveUpdate` (`src/update/freshness.ts`) refuses a signed manifest older
than the running build (`RollbackRefusedError`, reported as
`preflight_manifest`): base `major.minor.patch` orders builds, same base
compares `builtAt` (canary / rc labels are ignored, as in the control plane's
`isDowngrade`), the same commit is never a rollback, and missing or
unparsable evidence (dev checkout `unstamped`, the trunk drop's absent
`version`) is never refused. There is deliberately **no** expiry or sequence
field: a host offline for weeks must still update and old manifests lack it.
Break-glass is host-side only: `TURBOPANEL_ALLOW_DOWNGRADE=1` in the daemon
environment for the daemon's own check, and an operator running run.sh as root
with `--allow-downgrade` (or `TURBOPANEL_ALLOW_DOWNGRADE=1` in root's
environment) for root's check below. Nothing in a WebSocket message can lift
either.

## Root build floor (no rollback through root)

The daemon's check runs in the daemon, and the daemon account can also ask
root for an update directly (`sudo tp-orchestrate update --manifest-url`
naming any tag on the rail). An older signed release would put back root
helpers (`tp-host`, `tp-orchestrate`) that later releases fixed, so root keeps
its own floor:

- `run.sh` refuses a daemon manifest older than `<install>/lib/installed-build`
  (root-owned `0644` in the root-owned `lib/`; `commit=`, `version=`,
  `builtAt=`) right after verifying its signature and before stopping the
  daemon or downloading anything (`tp_check_daemon_build_floor`). It writes
  the record after every successful package swap
  (`tp_write_daemon_build_floor`). A host without the record takes its floor
  from `bin/turbopaneld --version`; a host whose native binary cannot run (the
  JS runtime) gets its first record on the first update through a fixed
  installer. The comparison (`tp_daemon_build_older`) mirrors `isRollback`
  (same commit, base version, then `builtAt`); one difference: a manifest with
  no parsable `builtAt` is refused over a known floor, since every release
  manifest carries one. `src/update/run-sh-build-floor.test.ts` runs a corpus
  through both.
- The only override is the operator's: `run.sh --allow-downgrade` or
  `TURBOPANEL_ALLOW_DOWNGRADE=1` in root's own environment (forwarded across
  the sudo re-exec as the flag). daemon.env is never read for it;
  `tp-orchestrate` unsets the variable and refuses the flag on every verb.
- `tp-orchestrate update` and `update-colocated` refuse to run a fetched
  installer that lacks the floor check (`tp_require_build_floor_installer`):
  the installer comes from the channel the caller names, and one from before
  the floor would not compare.
- `--manifest-url` stays accepted (the control plane names exact builds on a
  signed session); the floor is what keeps an exact pin from going backwards.
- Automatic rollback (`tp-update-guard`) acts only on root's own record,
  `<install>/lib/update-guard-armed`, which `tp_arm_update_guard` writes next to
  the daemon's `update-guard.json` copy: target and previous commit, deadline,
  boot id, restart count, and the daemon unit's `NRestarts` at arm time (the
  early crash-loop rollback). The guard moves back only the previous build root
  recorded (it checks `bin/turbopaneld.prev --version`), consumes the record
  on rollback, disarm or the attention threshold, and drops it after a reboot
  or an hour past the deadline. A daemon-written `update-guard.json` alone
  moves nothing. tp-host refuses every `systemctl` verb but `is-*` on
  `turbopaneld-update-guard*`. The guard never lowers the floor, so after a
  rollback the next update may only be the failed build again or newer.
- Not covered: the control plane and web interface packages
  (`update-instance`) have no root floor yet.

## Update channel pin

The host channel (`TURBOPANEL_UPDATE_CHANNEL` in daemon.env, written by the
installer) holds against the control plane's messages. An `update` or
`instance-update` naming another channel is honoured only when it arrived on a
verified signed session (pinned server, signed hello applied); on an unsigned
session it is refused before anything runs with `errorCode` `channel_pinned`
(`decideUpdateChannel`, `src/instance/update-channel-pin.ts`). An absent or
equal message channel keeps the host channel. A channel name this daemon does
not know is refused with `errorCode` `channel_unknown` on any session: running
the host channel in its place would leave the control plane believing the
named channel ran. The host-side way to
change it is re-running the installer with `TURBOPANEL_UPDATE_CHANNEL`. Root
does not compare a requested channel against a stored one (`tp-orchestrate`
only allowlists the name): root cannot verify a control-plane signature, so
such a pin would also block the signed path.

The build inside the channel has the same rule, as two pure checks in the same
file (`decideMessageManifest`, `assertMessageManifestIsChannelHead`, code
`manifest_pinned`). On an unsigned session a message manifest URL may only be
the channel's own manifest, or the one exact build that manifest names right
now (`pinnedChannelManifestUrl` of the head's `version`): the control plane
targets the channel's current build, so an honest run passes, while another
channel's manifest, an older build or a release-candidate tag on a release host
does not. A signed session and a development overlay host keep naming any
build on the rail. An exact build still wins over a pin an earlier managed
update left in `daemon.env` (`selectUpdateManifestUrl`); dropping the message
URL instead would put that stale pin back in charge and freeze the host. The
two call sites that read a message manifest URL (`#applyUpdate`,
`#applyInstanceUpdate` in `src/instance/client.ts`, the control plane and web
interface pins each against their own rail) run both checks through
`#holdMessageManifest` before the URL reaches `selectUpdateManifestUrl`. When
the decision is `head`, the signed manifest at the channel head is fetched with
`fetchChannelHeadVersion` (`src/instance/run-reconcile.ts`, always verified as a
pinned manifest) and its `version` is compared; any refusal is `manifest_pinned`.
Tests: `src/instance/client.test.ts` (unsigned) and
`src/instance/client-signed-session.test.ts` (signed).
