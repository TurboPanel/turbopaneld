# Guards, CI and Release Gates — AGENTS.md

Daemon repo context: `../AGENTS.md`. Cross-repo `../<repo>/…` links are relative
to the repo root.

## Guards and Tests

**Guards / tests:**

- `deno task check:layout` (`scripts/check-production-layout.ts`) — asserts the
  production FHS tree resolves to the canonical absolute paths and that no
  production source (`src/**`, excluding `*.test.ts` and `src/paths/layout.ts`)
  references `/opt/turbopanel/platform` or the retired `share/ansible`. Wired
  into `publish-daemon-trunk.yml`.
- `deno task test` / `test:coverage` / `lint` / `fmt:check` / `check` /
  `notices:check` — quality surface in `deno.json`. `notices:generate` writes
  `THIRD_PARTY_NOTICES.md` from `deno.lock` and orchestration pins
  (GPL-3.0-or-later Ansible tooling is a reviewed orchestration exception).
  Release packaging stages that file at
  `opt/turbopanel/share/THIRD_PARTY_NOTICES.md`.
  `tp_install_verified_channel_release` copies the verified notice into
  `/opt/turbopanel/share/THIRD_PARTY_NOTICES.md` on install/update. The `test`
  task grants `-A` at the process level on purpose: Deno's per-test
  `permissions` option can only _reduce_ from the process grant, so a narrower
  task grant would silently break `src/commands/ping.test.ts`
  (`sys: ["hostname"]`), `src/commands/stop-environment.test.ts` (`run: true`),
  and the twelve `permissions:` blocks in `src/instance/client.test.ts`. **Do
  not weaken or remove any existing per-test `permissions` block.** A scoped
  `run: ["cmd"]` cannot inherit `LD_*` / `DYLD_*` (Deno 2.9 `NotCapable`); CI
  `actions/setup-python` exports `LD_LIBRARY_PATH` before `test:coverage`, so
  those `Deno.Command` spawns must `clearEnv: true` (or otherwise unset the
  vars). Unscoped `run: true` / process `-A` is fine. Coverage writes
  `coverage/lcov.info` (gitignored; already in Sonar / layout `SKIP_DIRS`).
- **SonarCloud coverage (CI):** `.github/workflows/verify.yml` runs
  `deno task test:coverage` then uploads LCOV via
  `sonar.javascript.lcov.reportPaths=coverage/lcov.info` (CI-based analysis;
  Automatic Analysis must stay **off** for `turbopanel_turbopaneld`). Deno may
  emit absolute `SF:/home/runner/work/...` paths on Actions; verify.yml strips
  the checkout prefix to repo-relative `SF:src/...` before upload. The project
  uses the built-in **Sonar way** quality gate, which fails when **coverage on
  new code is below 80%** (`new_coverage` LT 80); the scan waits on the gate
  (`sonar.qualitygate.wait=true`). Same-repo PRs and trunk **require**
  `SONAR_TOKEN` (hard fail); fork PRs skip the scan so fmt/lint/tests still
  gate. Quality gate failure fails verify (and therefore trunk `publish`, which
  `needs: verify`). After switching from Automatic Analysis, reset **New Code**
  (Administration → New Code) so the baseline is not months of uncovered
  history. Sibling `turbopanel` / `ui` also use CI-based analysis; `website`
  still uses Automatic Analysis. Coverage exclusions include `**/*.test.ts`,
  `src/testing/**`, `src/build-info.ts`, `dist/**`, and `publish/**`.
  **`sonar.sources` / `sonar.tests` / `sonar.test.inclusions`** must stay set
  (`src` + `orchestration` + `scripts` + `main.ts`; tests = `**/*.test.ts` and
  `src/testing/**`). The `denoS2187` issue-ignore (`typescript:S2187` on
  `**/*.test.ts`) remains — LCOV import does not replace that false-positive
  suppression.
- `src/orchestration/assets.test.ts` — production/dev default trees, env
  overrides, and the `DENO_VERSION` ↔ role pin
  (`deno test src/orchestration/assets.test.ts`).
- `scripts/verify-release-root.sh` / `tp_verify_release_root`
  (`scripts/lib/release-artifacts.sh`) — reject dev-only paths, TS sources,
  `share/ansible`, or a leaked daemon source tree in a packaged release root.
  Release packaging helpers (`release-artifacts.sh`,
  `package-daemon-release.sh`, `bundle-orchestration.sh`,
  `verify-release-root.sh`) are **bash** — `deno.json` must invoke them with
  `bash`, not `sh` (Debian `/bin/sh` is dash and silently skips prune/verify
  checks that use `[[`). `run.sh` stays POSIX and inlines a separate copy of the
  manifest helpers for `curl | sh`.
- **Secret scan and contract drift in CI:** `verify.yml` runs
  `scripts/scan-secrets.sh --all` over every tracked file (the pre-commit hook
  only sees staged files, so a flagged line in a file nobody staged is caught
  here, and a stale `.secretscan-allowlist` entry is warned about). Its
  `contract-drift` job checks out `TurboPanel/turbopanel` (same-named branch,
  else trunk) beside this repo and runs `check:contract-drift` with
  `TURBOPANEL_REQUIRE_SIBLING=1`, so a missing sibling fails instead of
  skipping. `scripts/scan-secrets.sh`, `scripts/scan-secrets.patterns` and
  `scripts/scan-secrets.selftest.sh` are byte-identical in turbopanel,
  turbopaneld, ui, website and dev: change all five together (each repo keeps a
  copy because the pre-commit hook runs it locally). The rules in the patterns
  file cover private key blocks, vendor tokens, JWTs, connection URLs with
  credentials, secret-looking assignments and forbidden file names (dotenv
  files, `*.pem`, `*.key`, daemon identity files, …); the scanner reports the
  rule id and location, never the matching text. `--all` scans the tree;
  `--range BASE..HEAD` scans every line the PR's commits added, so a secret
  added and removed inside a PR is still caught (CI runs it on PRs into trunk).
  Allowlist entries in `.secretscan-allowlist` are `path:full line text` (or
  `@path exact/file` for a forbidden file name), each needs a `# reason:`
  comment above it, and wildcards are rejected. The self-test builds its
  fixtures at run time from fragments; dev's `src/lib/scan-secrets.test.ts` runs
  it and, with the siblings checked out in dev CI, fails if any copy drifts.
- **CI gate:** `.github/workflows/verify.yml` is the canonical quality gate —
  reusable via `workflow_call`, the trunk `publish` job `needs: verify`, and
  promotion re-verifies artifact hashes only (no new compile from source).
- **Scheduled checks live in the control plane repository.** Issues are enabled
  only there, so the tunnel connector release check and the repository signing
  key check run as workflows in `TurboPanel/turbopanel`, which fetch this repo's
  `trunk` and run `scripts/check-connector-release.ts` and
  `scripts/check-repo-keys.ts` (exit codes in that script's header). Do not add
  a workflow here that files issues.

## Gate Matrix and Promotion

**Gate matrix** (one policy with the dev repo):

| Stage                | dev                                | daemon                                                                                                                                                                                             | Rationale                                                                                                                                                                      |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pre-commit           | scan-secrets only (tests deferred) | scan-secrets + `deno fmt` + `lint` + `check:layout` + `check:vocabulary` (typecheck/tests deferred)                                                                                                | secret scan always; daemon fmt/guards via the pinned Deno or `vagrant ssh`; the cheap half of `verify.yml` runs in ~1s so contract breaks never reach CI; suites in CI / guest |
| PR → `trunk`         | `verify.yml`                       | `verify.yml` (`verify` + `contract-drift`, folded into the single `ci-ok` job that the ruleset requires)                                                                                           | blocks merge                                                                                                                                                                   |
| push `trunk`         | `verify.yml`                       | `verify.yml`; `publish` job `needs: verify` → the rolling GitHub `canary` pre-release (`canary` job, via `TurboPanel/dev` `gh-canary.yml`)                                                         | nothing compiles from failing code                                                                                                                                             |
| promote → rc/release | `promote.yml` (notes-only)         | `promote.yml` → `TurboPanel/dev` `gh-promote.yml`: **signature + sha256/size of the tested canary build, manifest re-signed, same bytes**; gh-release.yml re-downloads and re-hashes after publish | no new code enters after publish                                                                                                                                               |

**Automatic promotion (two PRs, the normal path):** `promote-prs.yml` keeps a
**trunk → staging** PR ("Release Candidate x.y.z-rc.N") open after every green
trunk build (opened with the Release App token so `ci-ok` runs; merge commit
only). Merging it makes a push to `staging`, which runs `publish-rc.yml` (from
the pushed commit, so the first merge already works): it finds the merged PR's
head commit, waits for that commit's canary build, finds the canary manifest
that names exactly that commit, then runs the shared promote workflows with **no
approval gate** (`approval-environment: ""` — the merge is the act) to publish
`v<base>-rc.<N>` (N = one past the highest existing rc tag; a bad rc is fixed on
trunk and the next merge publishes rc.N+1), and opens/refreshes the **staging →
live** PR "Release x.y.z". `verify.yml` skips Sonar on PRs into staging/live (no
new code in a promotion). Merging the staging → live PR pushes to `live`, which
runs `publish-release.yml`: it picks the newest rc that has not shipped, runs
the shared promote workflows (the `release` environment approval stays on this
hop until the path has run once end to end) to publish `v<x.y.z>`. **The version
lives in the committed files, and the tags say what it should be.** The tags
work out the base: the newest release tag's next patch, unless an unreleased rc
or a `start/vX.Y.0` marker names a higher version; canaries are
`<base>-canary.<N>` with N restarting at 1 per base (TurboPanel/dev's Version
From Tags action, `scripts/promote/version.sh`). The committed fields
(`deno.json` `version`, `sonar-project.properties` `sonar.projectVersion`) must
already say that base: `publish-daemon-trunk.yml` runs
`node scripts/set-version.mjs --check <base>` right after working it out and
refuses the canary when any field disagrees, naming the file. So right after
each release the committed version has to move to the next patch:
`publish-release.yml`'s last job (`start-next`, after finalize) works out the
new base from the tags (refusing when the newest release is not the one it just
published) and, with the TurboPanel Release App token, opens a PR "chore: start
X.Y.Z" through TurboPanel/dev's Start Version PR action (it runs
`node scripts/set-version.mjs X.Y.Z` and makes a signed commit through the
GitHub API, never a `git push`). The PR merges itself once its checks pass
(`auto-merge: "true"`); canaries are refused until it does. A bump by hand is
the same command in an ordinary PR. Only the canary path checks; rc and release
reuse the canary's bytes. A minor or major is started with turbopaneld's **Start
Next Version** workflow (`bump: minor|major`), which pushes the `start/` marker
in all four repos and opens the same kind of "chore: start X.Y.0" PR in each,
which merges itself once its checks pass (pressing it again retries a PR that
failed to open); nothing is rebuilt, since each repo's canary is refused until
its PR merges. The release workflows pin TurboPanel/dev twice: the reusable
promote workflows and their `dev-ref` at one sha, the composite actions and
`scripts/promote` checkouts at one sha (`scripts/release-workflows.test.ts`).
The Promote OK check (the `gh-promote-ok.yml` calls in `promote-ok.yml` and
`promote-ok-recheck.yml`, with their `dev-ref`) is its own pin group, so a fix
to it can ship without moving the rest of the chain. The plain `promote.yml`
form below is **break-glass only**.

**Promotion (`.github/workflows/promote.yml`, break-glass):** one click moves a
tested build up a channel — `to=rc` turns a canary build (`source` = build id,
canary version or `manifest-<version>.json` from the rolling canary release)
into `v<base>-rc.<N>` and fast-forwards `staging`; `to=release` turns
`v<base>-rc.<N>` into `v<base>` (`releases/latest`; the rolling `rc` pointer is
re-pointed at it) and fast-forwards `live`. Same bytes: the source manifest's
signature and every asset's sha256/size are verified first, the assets are
renamed, the manifest rewritten and re-signed, and the tag is created at the
source commit (an existing tag elsewhere = burned version, fails). The three
jobs are `TurboPanel/dev`'s `gh-promote.yml` → `gh-release.yml` →
`gh-promote-finalize.yml` pinned to ONE dev sha, passed again as `dev-ref`;
`signer-ref` is the turbopaneld commit carrying `scripts/sign-manifest.ts` + the
key pin — bump it together with the signer pin in `release.yml`. Approval = the
`release` environment (prepare, then finalize). `to=release` needs the
TurboPanel Release App secrets (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`:
bare tags and the `live` push are ruleset-bypass only) and refuses to start
without them; `to=rc` runs on `GITHUB_TOKEN` and only its `staging` push fails —
with the exact manual `git push` — until the App exists. `release.yml` ignores
tag pushes by `[bot]` actors so an App-created tag does not race the promotion
with a from-source rebuild. Repos release independently: no release waits on a
matching release in another repo — except a new minor (x.y.0), where turbopanel
and ui each need an rc of it before the daemon may release it (`minor-gate` in
`verify.yml`, dev `gh-minor-gate.yml`; a patch is never gated), and
`publish-release.yml` re-runs their waiting Release PR checks after the daemon
release exists. Full contract: `../dev/AGENTS.md` → Release promotion.
