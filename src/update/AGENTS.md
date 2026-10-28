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
environment, or running `run.sh --manifest-url <older tag>` by hand (run.sh
itself does not compare versions). Nothing in a WebSocket message can lift it.
